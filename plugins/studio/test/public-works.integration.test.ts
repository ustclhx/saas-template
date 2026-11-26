import {
  aiModel,
  aiTask,
  createDb,
  type Database,
  file,
  type NewStudioWork,
  organization,
  studioWork,
  user,
} from '@saas/db'
import { newId } from '@saas/shared'
import { eq, sql, TransactionRollbackError } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { STUDIO_KINDS } from '../src/kinds.ts'
import {
  getPublicWorkBySlug,
  getPublicWorkForReport,
  getPublicWorkMedia,
  listPublicSitemapWorks,
  listPublicWorks,
  listRelatedPublicWorks,
} from '../src/web/public-works.ts'

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

let db: ReturnType<typeof createDb>

beforeAll(() => {
  const url = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
  if (!url) throw new Error('未配置 Studio 集成测试数据库')
  db = createDb(url)
})

afterAll(async () => db?.close())

async function withFixture(run: (tx: Transaction) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await run(tx)
      tx.rollback()
    })
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error
  }
}

async function createAuthor(tx: Transaction) {
  const userId = newId()
  const workspaceId = newId()
  await tx.insert(user).values({ id: userId, email: `${userId}@example.test`, name: 'Author' })
  await tx.insert(organization).values({ id: workspaceId, slug: workspaceId, name: 'Workspace' })
  return { userId, workspaceId, site: `studio-${workspaceId}` }
}

async function createWork(
  tx: Transaction,
  author: Awaited<ReturnType<typeof createAuthor>>,
  fields: Partial<
    Pick<
      NewStudioWork,
      'kind' | 'site' | 'moderation' | 'visibility' | 'featuredAt' | 'publishedAt' | 'showPrompt'
    >
  > = {},
) {
  const { userId, workspaceId, site } = author
  const id = newId()
  const taskId = newId()
  const fileId = newId()
  const kind = fields.kind ?? 'image'
  const slug = `work-${id}`
  const modelKey = `example-model-${id}`
  const prompt = 'Original author prompt'
  const r2Key = `ws/${workspaceId}/ai/${taskId}/0`
  const mime = kind === 'image' ? 'image/png' : 'video/mp4'
  const size = 42
  await tx.insert(aiTask).values({
    id: taskId,
    userId,
    workspaceId,
    kind,
    modelKey,
    pricing: { mode: 'per_call' },
    status: 'succeeded',
    input: { prompt },
    provider: 'test',
    providerRequestKey: taskId,
    deadlineAt: new Date('2025-01-01T00:00:00Z'),
  })
  await tx.insert(file).values({
    id: fileId,
    userId,
    workspaceId,
    purpose: 'ai_output',
    status: 'ready',
    r2Key,
    mime,
    size,
    sourceTaskId: taskId,
  })
  await tx.insert(studioWork).values({
    id,
    userId,
    workspaceId,
    fileId,
    taskId,
    kind,
    site,
    slug,
    title: 'A published work',
    modelKey,
    prompt,
    ...fields,
  })
  return { id, fileId, slug, modelKey, prompt, r2Key, mime, size }
}

function scope(site: string) {
  return { site, kinds: STUDIO_KINDS }
}

describe('Studio 公开作品查询', () => {
  it('详情与媒体请求只读取本站及已启用类型', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const work = await createWork(tx, author, { kind: 'video' })
      const details = { ...scope(author.site), slug: work.slug }
      const media = { ...scope(author.site), workId: work.id, version: 1 }

      expect(await getPublicWorkBySlug(tx, details)).toMatchObject({ id: work.id })
      expect(await getPublicWorkMedia(tx, media)).toEqual({
        r2Key: work.r2Key,
        mime: work.mime,
        size: work.size,
      })
      expect(await getPublicWorkBySlug(tx, { ...details, site: 'different-site' })).toBeNull()
      expect(await getPublicWorkMedia(tx, { ...media, site: 'different-site' })).toBeNull()
      expect(await getPublicWorkBySlug(tx, { ...details, kinds: ['image'] })).toBeNull()
      expect(await getPublicWorkMedia(tx, { ...media, kinds: ['image'] })).toBeNull()
      expect(await getPublicWorkMedia(tx, { ...media, version: 2 })).toBeNull()
    }))

  it('封禁立即隐藏作品，解封或封禁到期恢复可见', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const work = await createWork(tx, author, { moderation: 'approved' })
      const queryScope = scope(author.site)
      const details = { ...queryScope, slug: work.slug }

      await tx.update(user).set({ banned: null }).where(eq(user.id, author.userId))
      expect(await getPublicWorkBySlug(tx, details)).toMatchObject({ id: work.id })

      await tx.update(user).set({ banned: true }).where(eq(user.id, author.userId))
      expect(await listPublicWorks(tx, { ...queryScope, pageSize: 4 })).toMatchObject({ works: [] })
      expect(await getPublicWorkBySlug(tx, details)).toBeNull()
      expect(
        await getPublicWorkMedia(tx, { ...queryScope, workId: work.id, version: 1 }),
      ).toBeNull()
      expect(await listPublicSitemapWorks(tx, { ...queryScope, page: 1 })).toMatchObject({
        works: [],
      })

      await tx.update(user).set({ banned: false }).where(eq(user.id, author.userId))
      expect(await getPublicWorkBySlug(tx, details)).toMatchObject({ id: work.id })

      await tx
        .update(user)
        .set({ banned: true, banExpires: new Date('2025-01-01T00:00:00Z') })
        .where(eq(user.id, author.userId))
      expect(await getPublicWorkBySlug(tx, details)).toMatchObject({ id: work.id })
    }))

  it('账号删除后即使解除封禁，作品仍不可公开读取或举报', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const work = await createWork(tx, author, { moderation: 'approved' })
      const queryScope = scope(author.site)
      const details = { ...queryScope, slug: work.slug }
      const request = { ...queryScope, workId: work.id }

      await tx
        .update(user)
        .set({ email: `deleted+${newId()}@invalid`, banned: false })
        .where(eq(user.id, author.userId))
      expect(await getPublicWorkBySlug(tx, details)).toMatchObject({ id: work.id })

      await tx
        .update(user)
        .set({ email: `deleted+${author.userId}@invalid`, banned: false })
        .where(eq(user.id, author.userId))
      expect(await listPublicWorks(tx, { ...queryScope, pageSize: 4 })).toMatchObject({ works: [] })
      expect(await getPublicWorkBySlug(tx, details)).toBeNull()
      expect(await getPublicWorkMedia(tx, { ...request, version: 1 })).toBeNull()
      expect(await getPublicWorkForReport(tx, request)).toBeNull()
      expect(
        await listRelatedPublicWorks(tx, { ...queryScope, kind: 'image', workId: newId() }),
      ).toEqual([])
      expect(await listPublicSitemapWorks(tx, { ...queryScope, page: 1 })).toEqual({
        works: [],
        hasNextPage: false,
      })
    }))

  it('隐藏、下架、取消发布、软删文件或空间的作品均不可读取或举报', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const deletedAuthor = await createAuthor(tx)
      const anchor = await createWork(tx, author, { moderation: 'approved' })
      const hidden = await createWork(tx, author, { moderation: 'hidden' })
      const removed = await createWork(tx, author, { moderation: 'removed' })
      const unpublished = await createWork(tx, author, { visibility: 'private' })
      const deletedFile = await createWork(tx, author, { moderation: 'approved' })
      const otherSite = await createWork(tx, author, { site: 'different-site' })
      const deletedWorkspace = await createWork(tx, deletedAuthor, {
        site: author.site,
        moderation: 'approved',
      })
      await tx.update(file).set({ deletedAt: new Date() }).where(eq(file.id, deletedFile.fileId))
      await tx
        .update(organization)
        .set({ deletedAt: new Date() })
        .where(eq(organization.id, deletedAuthor.workspaceId))

      const queryScope = scope(author.site)
      const gallery = await listPublicWorks(tx, { ...queryScope, pageSize: 8 })
      expect(gallery.works.map(({ id }) => id)).toEqual([anchor.id])
      expect(
        await listRelatedPublicWorks(tx, { ...queryScope, kind: 'image', workId: anchor.id }),
      ).toEqual([])
      expect(await getPublicWorkForReport(tx, { ...queryScope, workId: anchor.id })).toMatchObject({
        id: anchor.id,
        workspaceId: author.workspaceId,
        moderation: 'approved',
        reportCount: 0,
      })
      for (const work of [hidden, removed, unpublished, deletedFile, otherSite, deletedWorkspace]) {
        const request = { ...queryScope, workId: work.id }
        expect(await getPublicWorkBySlug(tx, { ...queryScope, slug: work.slug })).toBeNull()
        expect(await getPublicWorkMedia(tx, { ...request, version: 1 })).toBeNull()
        expect(await getPublicWorkForReport(tx, request)).toBeNull()
      }
    }))

  it('详情仅公开已授权的提示词与作者标记，模型显示名从注册表回退到 key', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const hiddenPrompt = await createWork(tx, author)
      const sharedPrompt = await createWork(tx, author, { showPrompt: true })
      await tx.insert(aiModel).values({
        key: sharedPrompt.modelKey,
        kind: 'image',
        displayName: 'Example model',
        provider: 'test',
        providerModelId: 'test',
        pricing: { mode: 'per_call' },
      })

      const queryScope = scope(author.site)
      const ownWork = await getPublicWorkBySlug(tx, {
        ...queryScope,
        slug: hiddenPrompt.slug,
        viewerUserId: author.userId,
      })
      expect(ownWork).toMatchObject({
        prompt: null,
        displayName: hiddenPrompt.modelKey,
        isAuthor: true,
      })
      expect(ownWork).not.toHaveProperty('userId')
      expect(ownWork).not.toHaveProperty('workspaceId')

      const publicWork = await getPublicWorkBySlug(tx, { ...queryScope, slug: sharedPrompt.slug })
      expect(publicWork).toMatchObject({
        prompt: sharedPrompt.prompt,
        displayName: 'Example model',
        modelKey: sharedPrompt.modelKey,
        isAuthor: false,
        moderation: 'pending',
      })
      const gallery = await listPublicWorks(tx, { ...queryScope, pageSize: 2 })
      expect(gallery.works.find(({ id }) => id === sharedPrompt.id)).toMatchObject({
        displayName: 'Example model',
      })
      expect(gallery.works.map((work) => 'prompt' in work)).toEqual([false, false])
    }))

  it('精选排序和类型筛选独立，站点地图只包含同站审核通过的作品', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const first = await createWork(tx, author, {
        moderation: 'approved',
        featuredAt: new Date('2025-01-02T00:00:00Z'),
      })
      const second = await createWork(tx, author, {
        kind: 'video',
        featuredAt: new Date('2025-01-01T00:00:00Z'),
      })
      const ordinary = await createWork(tx, author)
      await createWork(tx, author, { site: 'different-site', moderation: 'approved' })

      const queryScope = scope(author.site)
      const featured = await listPublicWorks(tx, { ...queryScope, sort: 'featured', pageSize: 8 })
      expect(featured.works.map(({ id }) => id)).toEqual([first.id, second.id])
      const videos = await listPublicWorks(tx, { ...queryScope, kind: 'video', pageSize: 8 })
      expect(videos.works.map(({ id }) => id)).toEqual([second.id])
      const related = await listRelatedPublicWorks(tx, {
        ...queryScope,
        kind: 'image',
        workId: first.id,
      })
      expect(related.map(({ id }) => id)).toEqual([ordinary.id, second.id])
      expect(await listPublicSitemapWorks(tx, { ...queryScope, page: 1 })).toEqual({
        works: [{ slug: first.slug, lastmod: expect.any(Date) }],
        hasNextPage: false,
      })
      await expect(listPublicSitemapWorks(tx, { ...queryScope, page: 2 })).rejects.toMatchObject({
        status: 404,
      })
    }))

  it('数字页和游标的顺序一致，保留发布时间的微秒和相同时间的 id 排序', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      const first = await createWork(tx, author)
      const second = await createWork(tx, author)
      const third = await createWork(tx, author)
      await tx
        .update(studioWork)
        .set({ publishedAt: sql`'2025-01-01T00:00:00.000200Z'::timestamptz` })
        .where(eq(studioWork.id, first.id))
      for (const work of [second, third]) {
        await tx
          .update(studioWork)
          .set({ publishedAt: sql`'2025-01-01T00:00:00.000100Z'::timestamptz` })
          .where(eq(studioWork.id, work.id))
      }

      const paging = { ...scope(author.site), pageSize: 1 }
      const initial = await listPublicWorks(tx, paging)
      expect(initial.works.map(({ id }) => id)).toEqual([first.id])
      expect(initial.nextPage).toBe(2)
      if (!initial.nextCursor) throw new Error('缺少下一页游标')

      const [nextId, lastId] = [second.id, third.id].sort().reverse()
      const nextByPage = await listPublicWorks(tx, { ...paging, page: 2 })
      const nextByCursor = await listPublicWorks(tx, { ...paging, cursor: initial.nextCursor })
      expect(nextByPage.works.map(({ id }) => id)).toEqual([nextId])
      expect(nextByCursor.works).toEqual(nextByPage.works)
      if (!nextByCursor.nextCursor) throw new Error('缺少最后一页游标')
      const last = await listPublicWorks(tx, { ...paging, cursor: nextByCursor.nextCursor })
      expect(last.works.map(({ id }) => id)).toEqual([lastId])
      expect(last.nextCursor).toBeNull()
      await expect(listPublicWorks(tx, { ...paging, page: 4 })).rejects.toMatchObject({
        status: 404,
      })
    }))

  it('画廊数字页到达上限后仍可使用游标浏览', () =>
    withFixture(async (tx) => {
      const author = await createAuthor(tx)
      for (let count = 0; count < 51; count++) await createWork(tx, author)

      const paging = { ...scope(author.site), pageSize: 1 }
      const lastNumbered = await listPublicWorks(tx, { ...paging, page: 50 })
      expect(lastNumbered.works).toHaveLength(1)
      expect(lastNumbered.nextPage).toBeNull()
      if (!lastNumbered.nextCursor) throw new Error('缺少数字页之后的游标')
      const continuation = await listPublicWorks(tx, { ...paging, cursor: lastNumbered.nextCursor })
      expect(continuation.works).toHaveLength(1)
      expect(continuation.nextCursor).toBeNull()
    }))

  it('超过画廊或站点地图数字页上限时直接返回 404', async () => {
    const database = {
      select: vi.fn(() => {
        throw new Error('不应读取数据库')
      }),
    }
    const queryScope = scope('studio-page-bounds')
    await expect(
      listPublicWorks(database, { ...queryScope, page: 51, pageSize: 1 }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      listPublicSitemapWorks(database, { ...queryScope, page: 11 }),
    ).rejects.toMatchObject({
      status: 404,
    })
    expect(database.select).not.toHaveBeenCalled()
  })
})
