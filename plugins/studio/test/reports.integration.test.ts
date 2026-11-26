import { type StudioWork, scoped, studioReport, studioWork } from '@saas/db'
import { newId } from '@saas/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { STUDIO_KINDS } from '../src/kinds.ts'
import { resolveStudioSite } from '../src/site.ts'
import { getPublicWorkMedia, listPublicWorks } from '../src/web/public-works.ts'
import { STUDIO_ANONYMOUS_REPORT_LIMIT, submitStudioReport } from '../src/web/reports.ts'
import { handleStudioReport } from '../src/web/reports-http.ts'
import type { InvalidateStudioWork } from '../src/web/work-invalidation.ts'
import {
  deleteStudioFixtures,
  seedStudioOutput,
  seedStudioWorkspace,
  testDb,
} from './works-fixtures.ts'

const db = testDb()
const workspaceIds: string[] = []
const turnstileSecret = 'studio-test-turnstile-secret'
const turnstileToken = 'studio-test-turnstile-token'
const clientIp = '192.0.2.10'

afterAll(async () => {
  try {
    await deleteStudioFixtures(db, workspaceIds)
  } finally {
    await db.close()
  }
})

async function workspaceFixture() {
  const workspace = await seedStudioWorkspace(db)
  workspaceIds.push(workspace.workspaceId)
  return workspace
}

async function workFixture(
  moderation: 'pending' | 'approved' = 'pending',
  author?: { workspaceId: string; userId: string },
) {
  const workspace = author ?? (await workspaceFixture())
  const { fileId, taskId } = await seedStudioOutput(db, workspace)
  const tenant = scoped(db, workspace.workspaceId)
  const [work] = await tenant
    .insert(studioWork, {
      userId: workspace.userId,
      fileId,
      taskId,
      kind: 'image',
      site: `studio-${workspace.workspaceId}`,
      slug: `reported-${newId()}`,
      title: 'Reported work',
      modelKey: 'studio-fixture-image',
      moderation,
    })
    .returning()
  if (!work) throw new Error('缺少测试作品')
  return work
}

type ReportHttpDeps = Parameters<typeof handleStudioReport>[1]

function postReport(
  work: Pick<StudioWork, 'id' | 'site'>,
  overrides: Partial<Omit<ReportHttpDeps, 'db' | 'site' | 'kinds'>> = {},
  { token = turnstileToken, note }: { token?: string | null; note?: string } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('x-turnstile-token', token)
  const request = new Request('https://example.test/api/studio/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ workId: work.id, reason: 'spam', note }),
  })
  return handleStudioReport(request, {
    db,
    site: work.site,
    kinds: STUDIO_KINDS,
    hideThreshold: 3,
    clientIp,
    secret: 'studio-test-reporter-secret',
    turnstileSecret,
    getUserId: async () => null,
    limit: async () => ({ success: true }),
    verifyTurnstile: async () => true,
    ...overrides,
  })
}

function reportRows(work: Pick<StudioWork, 'id'>) {
  return db.query.studioReport.findMany({ where: eq(studioReport.workId, work.id) })
}

function readWork(work: Pick<StudioWork, 'id' | 'workspaceId'>) {
  return scoped(db, work.workspaceId).findById(studioWork, work.id)
}

describe('Studio 举报', () => {
  it('同一匿名网络重复提交成功，只保存一个不可逆举报键并计数一次', async () => {
    const work = await workFixture()
    const first = await postReport(work, {}, { note: 'First report' })
    const repeated = await postReport(work, {}, { note: 'Repeated report' })

    for (const response of [first, repeated]) {
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
    }
    const reports = await reportRows(work)
    expect(reports).toEqual([
      expect.objectContaining({
        reporterKey: expect.stringMatching(/^ip:/),
        reason: 'spam',
        note: 'First report',
      }),
    ])
    expect(reports[0]?.reporterKey).not.toContain(clientIp)
    expect(await readWork(work)).toMatchObject({ reportCount: 1, moderation: 'pending' })
  })

  it('Turnstile 校验返回失败时拒绝写入', async () => {
    const work = await workFixture()
    const verifyTurnstile = vi.fn(async () => false)
    const response = await postReport(work, { verifyTurnstile })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'TURNSTILE_FAILED' },
    })
    expect(verifyTurnstile).toHaveBeenCalledExactlyOnceWith(
      turnstileSecret,
      turnstileToken,
      clientIp,
    )
    expect(await reportRows(work)).toEqual([])
    expect(await readWork(work)).toMatchObject({ reportCount: 0 })
  })

  it('缺少 Turnstile 配置时拒绝访客，允许来自其他空间的登录用户举报', async () => {
    const work = await workFixture()
    const reporter = await workspaceFixture()
    const verifyTurnstile = vi.fn(async () => true)
    const options = { turnstileSecret: undefined, verifyTurnstile }

    expect((await postReport(work, options)).status).toBe(403)
    expect(await reportRows(work)).toEqual([])

    const response = await postReport(
      work,
      { ...options, getUserId: async () => reporter.userId },
      { token: null },
    )
    expect(response.status).toBe(200)
    expect(verifyTurnstile).not.toHaveBeenCalled()
    expect(await reportRows(work)).toEqual([
      expect.objectContaining({ reporterKey: `u:${reporter.userId}` }),
    ])
    expect(await readWork(work)).toMatchObject({ reportCount: 1 })
  })

  it('原生限流拒绝时返回 429 且不写入举报', async () => {
    const work = await workFixture()
    const response = await postReport(work, { limit: async () => ({ success: false }) })

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(await reportRows(work)).toEqual([])
  })

  it('多站点的举报只能提交给请求所在站点的作品', async () => {
    const work = await workFixture()
    const appUrl = 'https://www.example.test'
    const sites = {
      [work.site]: 'https://studio.example.test',
      other: 'https://other.example.test',
    }
    const foreign = resolveStudioSite(sites.other, appUrl, sites)
    const local = resolveStudioSite('https://studio.example.test', appUrl, sites)
    expect((await postReport({ ...work, site: foreign?.key ?? '' })).status).toBe(404)
    expect((await postReport({ ...work, site: local?.key ?? '' })).status).toBe(200)
    expect(await reportRows(work)).toHaveLength(1)
  })

  it('触发隐藏后同一人可以重试，无既有举报者仍收到 404', async () => {
    const work = await workFixture()
    const options = { hideThreshold: 1 }

    expect((await postReport(work, options)).status).toBe(200)
    expect((await postReport(work, options)).status).toBe(200)
    expect((await postReport(work, { ...options, clientIp: '192.0.2.11' })).status).toBe(404)
    expect(await readWork(work)).toMatchObject({ reportCount: 1, moderation: 'hidden' })
  })

  it('按作品执行滑动小时匿名限额，并为不同并发举报者只保留最后一个名额', async () => {
    const author = await workspaceFixture()
    const work = await workFixture('pending', author)
    const another = await workFixture('pending', author)
    const reporter = await workspaceFixture()
    const cap = STUDIO_ANONYMOUS_REPORT_LIMIT
    const options = { hideThreshold: cap + 3 }
    const first = await postReport(work, options)
    expect(first.status).toBe(200)
    const [oldestReport] = await reportRows(work)
    if (!oldestReport) throw new Error('缺少首条举报')
    await db
      .update(studioReport)
      .set({ createdAt: sql`clock_timestamp() - interval '59 minutes'` })
      .where(eq(studioReport.id, oldestReport.id))

    const initial = await Promise.all(
      Array.from({ length: cap - 2 }, (_, index) =>
        postReport(work, { ...options, clientIp: `198.51.100.${index + 1}` }),
      ),
    )
    expect(initial.map((response) => response.status)).toEqual(Array(cap - 2).fill(200))
    const signedIn = await postReport(work, { ...options, getUserId: async () => reporter.userId })
    expect(signedIn.status).toBe(200)

    const contenders = ['203.0.113.1', '203.0.113.2']
    const results = await Promise.all(
      contenders.map(async (clientIp) => ({
        clientIp,
        response: await postReport(work, { ...options, clientIp }),
      })),
    )
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 429])
    const rejected = results.find(({ response }) => response.status === 429)
    if (!rejected) throw new Error('缺少限流响应')
    await expect(rejected.response.json()).resolves.toMatchObject({
      error: { code: 'STUDIO_REPORT_LIMIT' },
    })
    expect(await reportRows(work)).toHaveLength(cap + 1)
    expect(await readWork(work)).toMatchObject({ reportCount: cap + 1 })
    expect((await postReport(work, options)).status).toBe(200)

    const request = { ...options, clientIp: rejected.clientIp }
    expect((await postReport(another, request)).status).toBe(200)
    await db
      .update(studioReport)
      .set({ createdAt: sql`clock_timestamp() - interval '61 minutes'` })
      .where(eq(studioReport.id, oldestReport.id))
    expect((await postReport(work, request)).status).toBe(200)
    expect(await reportRows(work)).toHaveLength(cap + 2)
    expect(await readWork(work)).toMatchObject({ reportCount: cap + 2 })
  })

  it.each(['pending', 'approved'] as const)(
    '不同举报人达到阈值时隐藏 %s 作品，记录原状态并在提交后通知缓存失效',
    async (moderation) => {
      const work = await workFixture(moderation)
      const site = { site: work.site, kinds: STUDIO_KINDS }
      const media = { ...site, workId: work.id, version: work.version }
      const gallery = { ...site, pageSize: 4 }
      let committedWork: Awaited<ReturnType<typeof readWork>> | undefined
      let committedReports: Awaited<ReturnType<typeof reportRows>> | undefined
      const invalidate = vi.fn<InvalidateStudioWork>(async () => {
        committedWork = await readWork(work)
        committedReports = await reportRows(work)
      })
      const options = { hideThreshold: 3, invalidate }

      await submitStudioReport(
        db,
        { ...site, workId: work.id, reporterKey: 'ip:first', reason: 'spam' },
        options,
      )
      await submitStudioReport(
        db,
        { ...site, workId: work.id, reporterKey: 'ip:second', reason: 'spam' },
        options,
      )
      expect(invalidate).not.toHaveBeenCalled()
      expect(await listPublicWorks(db, gallery)).toMatchObject({ works: [{ id: work.id }] })
      expect(await getPublicWorkMedia(db, media)).not.toBeNull()

      await submitStudioReport(
        db,
        { ...site, workId: work.id, reporterKey: 'ip:third', reason: 'spam' },
        options,
      )

      expect(invalidate).toHaveBeenCalledExactlyOnceWith({
        id: work.id,
        site: work.site,
        slug: work.slug,
        version: work.version,
      })
      expect(committedWork).toMatchObject({
        reportCount: 3,
        moderation: 'hidden',
        moderationBeforeHide: moderation,
        version: work.version + 1,
      })
      expect(committedReports).toHaveLength(3)
      expect(await listPublicWorks(db, gallery)).toMatchObject({ works: [] })
      expect(await getPublicWorkMedia(db, media)).toBeNull()
    },
  )
})
