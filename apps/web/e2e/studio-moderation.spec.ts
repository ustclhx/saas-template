import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { auditLog, createDb, scoped, studioReport, studioWork } from '@saas/db'
import { and, eq } from 'drizzle-orm'
import { listPublicWorks } from '../../../plugins/studio/src/web/public-works.ts'
import { listStudioWorks } from '../../../plugins/studio/src/web/works.ts'
import {
  seedStudioOutput,
  seedStudioWorkspace,
} from '../../../plugins/studio/test/works-fixtures.ts'
import templateConfig from '../../../template.config.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// openspec add-media-studio 任务 7.4：举报达到阈值自动隐藏 → 后台「被举报」栏恢复 → 回到画廊；
// 管理员下架（必填原因）→ 作者的作品查询看到下架原因；批量通过逐件审计（7.3）。
// 「我的作品」页面（8.2）尚未合入，作者侧经作品查询断言；画廊页面（6.1）尚未合入，经画廊查询断言。
// 设 EVIDENCE_DIR 时写入桌面浅色 / 深色截图，与 media-studio/AdminStudio.dc.html 副本对照。

test.skip(!templateConfig.plugins?.studio, 'studio 插件未启用')

const evidenceDir = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'add-media-studio',
  'admin-studio',
)
const SITE = 'default'
const KINDS = ['image', 'video'] as const

/** 后台布局的退出按钮在水合后才可用 */
const hydrated = (page: Page) =>
  expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled({ timeout: 30_000 })

async function shoot(page: Page, name: string) {
  if (!process.env.EVIDENCE_DIR) return
  mkdirSync(evidenceDir, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    // 切换明暗后等颜色过渡结束（行与按钮带 transition-colors）
    await page.waitForTimeout(400)
    await page.screenshot({ path: resolve(evidenceDir, `${name}-desktop-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const rowOf = (page: Page, title: string): Locator =>
  page
    .getByRole('table', { name: 'Works under review' })
    .getByRole('row')
    .filter({ hasText: title })

test('举报隐藏后恢复、下架原因与批量通过', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const sql = fixtureDb()
  const db = createDb(sql)
  const tag = randomUUID().slice(0, 8)
  const author = await seedStudioWorkspace(db)
  try {
    // 管理员：注册后提升为平台管理员
    const email = `studio-admin-${randomUUID()}@example.com`
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [admin] = await sql`select id from "user" where email=${email}`
    if (!admin) throw new Error('Missing admin fixture')
    await sql`update "user" set role='admin' where id=${admin.id}`

    // 作者的公开作品：已通过且已有两个不同举报人的未处理举报；其余三件待审核（发布时间最早，排在待审核栏首页）
    const tenant = scoped(db, author.workspaceId)
    async function seedWork(
      title: string,
      overrides: Partial<typeof studioWork.$inferInsert> = {},
    ) {
      const output = await seedStudioOutput(db, author)
      const id = randomUUID()
      await tenant.insert(studioWork, {
        id,
        fileId: output.fileId,
        taskId: output.taskId,
        userId: author.userId,
        site: SITE,
        kind: 'image',
        modelKey: 'studio-fixture-image',
        title,
        prompt: `${title} prompt`,
        slug: `e2e-${tag}-${id}`,
        ...overrides,
      })
      return id
    }
    const reportedTitle = `Misty lake ${tag}`
    const reported = await seedWork(reportedTitle, { moderation: 'approved', reportCount: 2 })
    await db.insert(studioReport).values([
      { workId: reported, reporterKey: `ip:e2e-${tag}-1`, reason: 'copyright' },
      { workId: reported, reporterKey: `ip:e2e-${tag}-2`, reason: 'copyright' },
    ])
    const early = (minute: number) => new Date(Date.UTC(2000, 0, 1, 0, minute))
    const removeTitle = `Retro poster ${tag}`
    const removeId = await seedWork(removeTitle, { publishedAt: early(0) })
    const batchTitles = [`Night city ${tag}`, `Cat nap ${tag}`]
    const batchIds = [
      await seedWork(batchTitles[0] ?? '', { publishedAt: early(1) }),
      await seedWork(batchTitles[1] ?? '', { publishedAt: early(2) }),
    ]
    const inGallery = async (id: string) =>
      (await listPublicWorks(db, { site: SITE, kinds: KINDS, pageSize: 100 })).works.some(
        (work) => work.id === id,
      )
    expect(await inGallery(reported)).toBe(true)

    // 第三个不同举报人（当前登录的管理员会话）达到默认阈值 3：作品自动隐藏并递增版本
    const response = await page.request.post('/api/studio/reports', {
      data: { workId: reported, reason: 'copyright' },
    })
    expect(response.status()).toBe(200)
    await expect(tenant.findById(studioWork, reported)).resolves.toMatchObject({
      moderation: 'hidden',
      reportCount: 3,
      version: 2,
    })
    expect(await inGallery(reported)).toBe(false)

    // 后台导航「作品审核」带数量（待审核 + 已隐藏）
    await page.goto('/admin')
    await hydrated(page)
    const navLink = page.getByRole('navigation').getByRole('link', { name: /^Content review/ })
    await expect(navLink).toContainText(/\d+/)
    await navLink.click()
    await expect(page).toHaveURL(/\/admin\/studio/)
    await expect(rowOf(page, removeTitle)).toBeVisible()
    await shoot(page, 'pending')

    // 被举报栏：隐藏作品带原因汇总，恢复后回到画廊
    await page.getByRole('tab', { name: /^Reported/ }).click()
    await expect(page).toHaveURL(/queue=reported/)
    const reportedRow = rowOf(page, reportedTitle)
    await expect(reportedRow).toContainText('Hidden')
    await expect(reportedRow).toContainText('3 · Copyright 3')
    await shoot(page, 'reported')
    await page.getByRole('tab', { name: /^Hidden/ }).click()
    await expect(rowOf(page, reportedTitle)).toBeVisible()
    await page.getByRole('tab', { name: /^Reported/ }).click()
    await rowOf(page, reportedTitle).getByRole('button', { name: 'Restore' }).click()
    await expect(rowOf(page, reportedTitle)).toHaveCount(0)
    await expect(tenant.findById(studioWork, reported)).resolves.toMatchObject({
      moderation: 'approved',
    })
    expect(await inGallery(reported)).toBe(true)
    const reports = await db.select().from(studioReport).where(eq(studioReport.workId, reported))
    expect(reports.map((report) => report.resolution)).toEqual(['restored', 'restored', 'restored'])

    // 待审核栏：下架必须选原因；说明只进审计，作者看到原因
    await page.getByRole('tab', { name: /^Pending/ }).click()
    await rowOf(page, removeTitle).getByRole('button', { name: 'Remove' }).click()
    const dialog = page.getByRole('dialog', { name: `Remove "${removeTitle}"` })
    await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled()
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Copyright infringement' }).click()
    await dialog.getByLabel(/^Note/).fill('Rights holder letter')
    await shoot(page, 'remove-dialog')
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(rowOf(page, removeTitle)).toHaveCount(0)
    const authorWorks = await listStudioWorks(db, { workspaceId: author.workspaceId, kinds: KINDS })
    expect(authorWorks.works.find((work) => work.work?.id === removeId)?.work).toMatchObject({
      moderation: 'removed',
      removalReason: 'Copyright infringement',
    })
    const [removalAudit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, removeId), eq(auditLog.action, 'studio.work.remove')))
    expect(removalAudit?.meta).toMatchObject({
      reason: 'Copyright infringement',
      note: 'Rights holder letter',
    })

    // 批量通过：两件各一条审计
    for (const title of batchTitles)
      await rowOf(page, title)
        .getByRole('checkbox', { name: `Select: ${title}` })
        .click()
    await expect(page.getByText('2 selected')).toBeVisible()
    await shoot(page, 'selected')
    await page.getByRole('button', { name: 'Approve selected' }).click()
    await expect(page.getByText('2 selected')).toHaveCount(0)
    for (const id of batchIds) {
      await expect(tenant.findById(studioWork, id)).resolves.toMatchObject({
        moderation: 'approved',
      })
      const audits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.targetId, id), eq(auditLog.action, 'studio.work.approve')))
      expect(audits).toHaveLength(1)
    }

    // 已下架栏显示原因，可恢复
    await page.getByRole('tab', { name: 'Removed' }).click()
    await expect(rowOf(page, removeTitle)).toContainText('Removed: Copyright infringement')
    await shoot(page, 'removed')
    await page.getByRole('tab', { name: /^Hidden/ }).click()
    await shoot(page, 'hidden')

    // 手机宽度：表格在自身容器内横向滚动，页面无横向滚动
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'Removed' }).click()
    await expect(rowOf(page, removeTitle)).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    // 审计行对 app 只追加且引用空间，空间与用户保留；只删作品，避免残留在其他用例的审核队列中
    await scoped(db, author.workspaceId).delete(studioWork, undefined)
    await sql.end()
  }
})
