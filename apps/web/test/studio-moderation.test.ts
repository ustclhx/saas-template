import { auditLog, type StudioWork, scoped, studioReport, studioWork, user } from '@saas/db'
import { moderateAdminStudioWork } from '@saas/plugin-studio/moderation'
import { newId } from '@saas/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  moderateStudioWork,
  studioAdminActionName,
} from '../../../plugins/studio/src/web/moderation.server.ts'
import {
  countStudioReviewQueue,
  getStudioReviewMedia,
  listStudioReviewQueue,
} from '../../../plugins/studio/src/web/moderation-queue.server.ts'
import { getPublicWorkBySlug } from '../../../plugins/studio/src/web/public-works.ts'
import {
  deleteStudioFixtures,
  seedStudioOutput,
  seedStudioWorkspace,
} from '../../../plugins/studio/test/works-fixtures.ts'
import { getAdminActionDefinition } from '../src/features/admin/actions.registry.ts'
import { templateConfig } from '../src/server/template-config.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

// 仅替换 RPC 传输与请求环境，入口校验、真实 adminAction 和数据库照常运行。
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let validate: { parse(input: unknown): unknown } | undefined
    const builder = {
      middleware: () => builder,
      inputValidator: (schema: typeof validate) => {
        validate = schema
        return builder
      },
      handler:
        (handler: (input: { context: unknown; data: unknown }) => unknown) =>
        async ({ context, data }: { context: unknown; data: unknown }) =>
          handler({ context, data: validate ? validate.parse(data) : data }),
    }
    return builder
  },
}))
vi.mock('@tanstack/react-start/server', () => ({ setResponseHeader: () => {} }))
vi.mock('@web/features/admin/admin.functions.ts', () => ({ adminMiddleware: {} }))
vi.mock('@web/server/runtime.ts', () => ({
  getWebRuntime: () => ({}),
  pluginUnavailable: () => false,
}))

const db = createAdminTestDb()
const migrator = createAdminTestDb('migrator')
const adminId = newId()
const site = `studio-review-${newId()}`
const context = { db, admin: { id: adminId } }
const moderate = (data: unknown) =>
  (
    moderateAdminStudioWork as (input: {
      context: typeof context
      data: unknown
    }) => Promise<unknown>
  )({ context, data })

describe.skipIf(!templateConfig.plugins.studio)('Studio 后台审核', () => {
  const workspaceIds: string[] = []
  let author: Awaited<ReturnType<typeof seedStudioWorkspace>>

  beforeAll(async () => {
    await db.insert(user).values({
      id: adminId,
      name: 'Studio admin',
      email: `${adminId}@studio-admin.example.test`,
      role: 'admin',
    })
    author = await seedStudioWorkspace(db)
    workspaceIds.push(author.workspaceId)
  })

  afterAll(async () => {
    await migrator.delete(auditLog).where(eq(auditLog.actorUserId, adminId))
    await deleteStudioFixtures(db, workspaceIds)
    await db.delete(user).where(eq(user.id, adminId))
    await Promise.all([db.$client.end(), migrator.$client.end()])
  })

  async function seedWork(
    overrides: Partial<
      Pick<
        StudioWork,
        | 'moderation'
        | 'moderationBeforeHide'
        | 'reportCount'
        | 'publishedAt'
        | 'site'
        | 'visibility'
      >
    > = {},
  ) {
    const { fileId, taskId, r2Key } = await seedStudioOutput(db, author)
    const id = newId()
    const work = {
      id,
      fileId,
      taskId,
      r2Key,
      site,
      title: '作品夹具',
      slug: `studio-review-${id}`,
      kind: 'image' as const,
      modelKey: 'fixture',
      prompt: '用于审核的提示词',
      ...overrides,
    }
    await scoped(db, author.workspaceId).insert(studioWork, { ...work, userId: author.userId })
    return work
  }

  const getWork = (id: string) => scoped(db, author.workspaceId).findById(studioWork, id)
  const audits = (id: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, adminId), eq(auditLog.targetId, id)))
      .orderBy(auditLog.id)

  it('通过、精选和取消精选经 adminAction 提交状态与审计', async () => {
    const { id, slug } = await seedWork()
    let committed: unknown
    const invalidate = vi.fn(async () => {
      committed = { work: await getWork(id), audits: await audits(id) }
    })
    await expect(
      moderateStudioWork(context, { workId: id, action: 'approve' }, invalidate),
    ).resolves.toMatchObject({ moderation: 'approved', version: 1 })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ id, site, slug, version: 1 })
    expect(committed).toMatchObject({
      work: { moderation: 'approved', reviewedBy: adminId },
      audits: [{ action: 'studio.work.approve' }],
    })

    await expect(
      moderateStudioWork(context, { workId: id, action: 'feature' }),
    ).resolves.toMatchObject({
      featuredAt: expect.any(Date),
    })
    await expect(getWork(id)).resolves.toMatchObject({ featuredAt: expect.any(Date) })
    await expect(
      moderateStudioWork(context, { workId: id, action: 'unfeature' }),
    ).resolves.toMatchObject({
      featuredAt: null,
    })
    await expect(getWork(id)).resolves.toMatchObject({ featuredAt: null })
    expect(await audits(id)).toMatchObject([
      { action: 'studio.work.approve', workspaceId: author.workspaceId, targetType: 'studio_work' },
      { action: 'studio.work.feature', meta: { featured: true } },
      { action: 'studio.work.unfeature', meta: { featured: false } },
    ])
    for (const action of ['approve', 'remove', 'restore', 'feature', 'unfeature'] as const)
      expect(getAdminActionDefinition(studioAdminActionName(action))?.stepUp).toBe('never')
  })

  it('下架原因必填；有效原因随下架写入，恢复后回到待审', async () => {
    const { id, slug } = await seedWork({ moderation: 'approved', reportCount: 1 })
    await db
      .insert(studioReport)
      .values({ workId: id, reporterKey: 'ip:fixture', reason: 'copyright' })
    for (const reason of [undefined, '   ', 'a'.repeat(201)])
      await expect(moderate({ workId: id, action: 'remove', reason })).rejects.toMatchObject({
        name: 'ZodError',
      })
    await expect(audits(id)).resolves.toEqual([])

    const invalidate = vi.fn()
    await expect(
      moderateStudioWork(
        context,
        { workId: id, action: 'remove', reason: ' copyright ' },
        invalidate,
      ),
    ).resolves.toMatchObject({ moderation: 'removed', removalReason: 'copyright', version: 2 })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ id, site, slug, version: 1 })
    await expect(getPublicWorkBySlug(db, { site, slug, kinds: ['image'] })).resolves.toBeNull()
    await expect(
      moderateStudioWork(context, { workId: id, action: 'restore' }),
    ).resolves.toMatchObject({
      moderation: 'pending',
      removalReason: null,
      version: 2,
    })
    expect(await audits(id)).toMatchObject([
      { action: 'studio.work.remove', meta: { reason: 'copyright', moderationAfter: 'removed' } },
      { action: 'studio.work.restore', meta: { moderationAfter: 'pending' } },
    ])
    expect(await db.select().from(studioReport).where(eq(studioReport.workId, id))).toMatchObject([
      { resolution: 'restored', resolvedAt: expect.any(Date) },
    ])
  })

  it('隐藏作品恢复前态并处理举报，保留累计和原有处理结果', async () => {
    const restoreSite = `${site}-restore`
    const { id, slug } = await seedWork({
      site: restoreSite,
      moderation: 'hidden',
      moderationBeforeHide: 'approved',
      reportCount: 2,
    })
    const resolvedAt = new Date('2026-01-01T01:02:03Z')
    await db.insert(studioReport).values([
      { workId: id, reporterKey: 'ip:old', reason: 'spam', resolvedAt, resolution: 'prior' },
      { workId: id, reporterKey: 'ip:new', reason: 'spam' },
    ])
    await expect(
      listStudioReviewQueue(db, { site: restoreSite, queue: 'reported' }),
    ).resolves.toMatchObject({
      rows: [{ id, reportReasons: [{ reason: 'spam', total: 2, unresolved: 1 }] }],
    })

    const result = await moderateStudioWork(context, { workId: id, action: 'restore' })
    expect(result.moderation).toBe('approved')
    await expect(getWork(id)).resolves.toMatchObject({ reportCount: 2, moderationBeforeHide: null })
    await expect(
      getPublicWorkBySlug(db, { site: restoreSite, slug, kinds: ['image'] }),
    ).resolves.toMatchObject({
      id,
      moderation: 'approved',
    })
    await expect(
      listStudioReviewQueue(db, { site: restoreSite, queue: 'reported' }),
    ).resolves.toEqual({
      rows: [],
      hasMore: false,
    })
    expect(await db.select().from(studioReport).where(eq(studioReport.workId, id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reporterKey: 'ip:old', resolvedAt, resolution: 'prior' }),
        expect.objectContaining({
          reporterKey: 'ip:new',
          resolvedAt: expect.any(Date),
          resolution: 'restored',
        }),
      ]),
    )
  })

  it('审核队列按站点、状态与偏移读取，支持已下架作品的签名预览', async () => {
    const queueSite = `${site}-queue`
    const before = await countStudioReviewQueue(db)
    const older = await seedWork({ site: queueSite, publishedAt: new Date('2026-01-01') })
    const newer = await seedWork({ site: queueSite, publishedAt: new Date('2026-02-01') })
    const hidden = await seedWork({ site: queueSite, moderation: 'hidden' })
    const removed = await seedWork({ site: queueSite, moderation: 'removed' })
    await seedWork({ site: queueSite, visibility: 'private' })
    await expect(countStudioReviewQueue(db)).resolves.toBe(before + 3)

    const pending = await listStudioReviewQueue(db, { site: queueSite })
    expect(pending.rows.map(({ id }) => id)).toEqual([older.id, newer.id])
    await expect(listStudioReviewQueue(db, { site: queueSite, offset: 1 })).resolves.toMatchObject({
      rows: [{ id: newer.id, prompt: '用于审核的提示词', workspaceId: author.workspaceId }],
      hasMore: false,
    })
    await expect(
      listStudioReviewQueue(db, { site: queueSite, queue: 'hidden' }),
    ).resolves.toMatchObject({
      rows: [{ id: hidden.id }],
    })
    await expect(
      listStudioReviewQueue(db, { site: queueSite, queue: 'removed' }),
    ).resolves.toMatchObject({
      rows: [{ id: removed.id }],
    })

    const presignDownload = vi.fn(async () => 'https://storage.example.test/signed')
    await expect(getStudioReviewMedia(db, { presignDownload }, removed.id)).resolves.toEqual({
      url: 'https://storage.example.test/signed',
      mime: 'image/webp',
    })
    expect(presignDownload).toHaveBeenCalledExactlyOnceWith(removed.r2Key)
  })

  it('管理员事务会拒绝被撤销的角色，不变更状态或写审计', async () => {
    const { id } = await seedWork()
    await expect(
      moderateStudioWork({ db, admin: { id: author.userId } }, { workId: id, action: 'approve' }),
    ).rejects.toMatchObject({ isNotFound: true })
    await expect(getWork(id)).resolves.toMatchObject({ moderation: 'pending' })
  })
})
