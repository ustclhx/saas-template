import { auditLog, type StudioWork, scoped, studioReport, studioWork, user } from '@saas/db'
import { moderateAdminStudioWork, moderateAdminStudioWorks } from '@saas/plugin-studio/moderation'
import { setStudioMediaInvalidator } from '@saas/plugin-studio/work-invalidation'
import { newId } from '@saas/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  moderateStudioWork,
  moderateStudioWorks,
  studioAdminActionName,
} from '../../../plugins/studio/src/web/moderation.server.ts'
import {
  countStudioReviewQueue,
  countStudioReviewTabs,
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
const moderateBatch = (data: unknown) =>
  (
    moderateAdminStudioWorks as (input: {
      context: typeof context
      data: unknown
    }) => Promise<unknown>
  )({ context, data })
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
    setStudioMediaInvalidator(invalidate)
    try {
      await expect(
        moderate({ workId: id, action: 'remove', reason: ' copyright ' }),
      ).resolves.toMatchObject({ moderation: 'removed', removalReason: 'copyright', version: 2 })
    } finally {
      setStudioMediaInvalidator(() => {})
    }
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

  it('批量通过逐件独立提交与审计，部分失败按件返回（tasks 7.3）', async () => {
    const first = await seedWork()
    const second = await seedWork()
    const removed = await seedWork({ moderation: 'removed' })
    const missing = newId()
    // 缓存失效在循环结束后一次处理，只含已提交的件
    const invalidateMany = vi.fn()
    setStudioMediaInvalidator(Object.assign(vi.fn(), { many: invalidateMany }))
    let results: unknown
    try {
      results = await moderateBatch({
        action: 'approve',
        workIds: [first.id, removed.id, missing, second.id, first.id],
      })
    } finally {
      setStudioMediaInvalidator(() => {})
    }
    expect(invalidateMany).toHaveBeenCalledExactlyOnceWith([
      { id: first.id, site, slug: first.slug, version: 1 },
      { id: second.id, site, slug: second.slug, version: 1 },
    ])
    expect(results).toEqual([
      { workId: first.id, ok: true, moderation: 'approved' },
      { workId: removed.id, ok: false, code: 'STUDIO_MODERATION_CONFLICT' },
      { workId: missing, ok: false, code: 'NOT_FOUND' },
      { workId: second.id, ok: true, moderation: 'approved' },
    ])
    await expect(getWork(first.id)).resolves.toMatchObject({ moderation: 'approved' })
    await expect(getWork(second.id)).resolves.toMatchObject({ moderation: 'approved' })
    await expect(getWork(removed.id)).resolves.toMatchObject({ moderation: 'removed' })
    // 每件一条审计；失败件不写审计
    expect(await audits(first.id)).toMatchObject([{ action: 'studio.work.approve' }])
    expect(await audits(second.id)).toMatchObject([{ action: 'studio.work.approve' }])
    await expect(audits(removed.id)).resolves.toEqual([])

    // 超过 50 件、空列表或缺少下架原因由入口校验拒绝，不产生任何写入
    const many = Array.from({ length: 51 }, () => newId())
    for (const data of [
      { action: 'approve', workIds: many },
      { action: 'approve', workIds: [] },
      { action: 'remove', workIds: [first.id] },
    ])
      await expect(moderateBatch(data)).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('管理员权限失效时批量停止，其余件标为权限失效且不写入', async () => {
    const a = await seedWork()
    const b = await seedWork()
    await expect(
      moderateStudioWorks(
        { db, admin: { id: author.userId } },
        { action: 'approve', workIds: [a.id, b.id] },
      ),
    ).resolves.toEqual([
      { workId: a.id, ok: false, code: 'ADMIN_ACCESS_REVOKED' },
      { workId: b.id, ok: false, code: 'ADMIN_ACCESS_REVOKED' },
    ])
    await expect(getWork(a.id)).resolves.toMatchObject({ moderation: 'pending' })
    await expect(getWork(b.id)).resolves.toMatchObject({ moderation: 'pending' })
  })

  it('批量下架写入原因码（也接受自由文本），说明只进审计', async () => {
    const a = await seedWork({ moderation: 'approved' })
    const b = await seedWork()
    await expect(
      moderateBatch({
        action: 'remove',
        workIds: [a.id, b.id],
        reason: 'copyright',
        note: '权利人来信',
      }),
    ).resolves.toEqual([
      { workId: a.id, ok: true, moderation: 'removed' },
      { workId: b.id, ok: true, moderation: 'removed' },
    ])
    for (const work of [a, b]) {
      await expect(getWork(work.id)).resolves.toMatchObject({
        moderation: 'removed',
        removalReason: 'copyright',
        version: 2,
      })
      expect(await audits(work.id)).toMatchObject([
        { action: 'studio.work.remove', meta: { reason: 'copyright', note: '权利人来信' } },
      ])
    }
    const c = await seedWork()
    await expect(
      moderateBatch({ action: 'remove', workIds: [c.id], reason: '仿冒品牌' }),
    ).resolves.toEqual([{ workId: c.id, ok: true, moderation: 'removed' }])
    await expect(getWork(c.id)).resolves.toMatchObject({ removalReason: '仿冒品牌' })
  })

  it('分栏数量：待审核、被举报与已隐藏；列表行带媒体版本', async () => {
    const before = await countStudioReviewTabs(db)
    const pending = await seedWork()
    const reported = await seedWork({ moderation: 'approved', reportCount: 1 })
    await db
      .insert(studioReport)
      .values({ workId: reported.id, reporterKey: `ip:${newId()}`, reason: 'spam' })
    await seedWork({ moderation: 'hidden' })
    await expect(countStudioReviewTabs(db)).resolves.toEqual({
      pending: before.pending + 1,
      reported: before.reported + 1,
      hidden: before.hidden + 1,
    })
    await expect(
      listStudioReviewQueue(db, { site, queue: 'pending' }).then(({ rows }) =>
        rows.find(({ id }) => id === pending.id),
      ),
    ).resolves.toMatchObject({ version: 1 })
  })

  it('管理员事务会拒绝被撤销的角色，不变更状态或写审计', async () => {
    const { id } = await seedWork()
    await expect(
      moderateStudioWork({ db, admin: { id: author.userId } }, { workId: id, action: 'approve' }),
    ).rejects.toMatchObject({ isNotFound: true })
    await expect(getWork(id)).resolves.toMatchObject({ moderation: 'pending' })
  })
})
