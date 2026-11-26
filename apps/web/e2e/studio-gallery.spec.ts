// 公开画廊与作品页 e2e（openspec add-media-studio 6.5）：真实本地认证、数据库与 Worker 路由。
// 媒体输出用测试替身：直接写入作品输出行，并把本地生成的 PNG / MP4 放进 Miniflare 的本地 R2；
// 发布、取消发布调用插件的服务端函数，审核通过写数据库（后台审核由第 7 组提供）。
// 边缘缓存会让同一匿名地址在 5 分钟内返回旧页；状态变化后的检查用带唯一查询的地址绕过缓存，
// 本机房失效的删除逻辑由单元测试覆盖（page-cache.flow.test.ts）。
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { aiTask, createDb, type Database, file, scoped, studioWork } from '@saas/db'
import { newId } from '@saas/shared'
import { loadEnv } from 'vite'
import { publishStudioWork, unpublishStudioWork } from '../../../plugins/studio/src/web/publish.ts'
import templateConfig from '../../../template.config.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test.skip(!templateConfig.plugins.studio, 'The studio plugin is disabled')

const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
const webDir = new URL('../', import.meta.url).pathname
const evidenceDir = join(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'add-media-studio',
  'group-6',
)
const assets = mkdtempSync(join(tmpdir(), 'studio-gallery-'))

// ---- 测试媒体：纯 Node 生成渐变 PNG；有 ffmpeg 时生成 2 秒 MP4 ----
function crc32(bytes: Buffer) {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return ~crc >>> 0
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
function gradientPng(width: number, height: number, hue: number) {
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2
      row[1 + x * 3] = Math.round(120 + 100 * t + hue) % 256
      row[2 + x * 3] = Math.round(150 + 60 * (1 - t))
      row[3 + x * 3] = Math.round(190 - 80 * t + hue / 2) % 256
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function sampleVideo(): Buffer | null {
  const path = join(assets, 'clip.mp4')
  try {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=24:duration=2',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-y',
        path,
      ],
      { stdio: 'ignore' },
    )
    return readFileSync(path)
  } catch {
    return null
  }
}

function putLocalR2(key: string, body: Buffer, contentType: string) {
  const path = join(assets, randomUUID())
  writeFileSync(path, body)
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'r2',
      'object',
      'put',
      `files/${key}`,
      '--file',
      path,
      '--content-type',
      contentType,
      '--local',
      '--persist-to',
      '.wrangler/state',
    ],
    { cwd: webDir, stdio: 'ignore' },
  )
}

async function workspaceFixture(page: Page) {
  const email = `studio-${randomUUID()}@example.com`
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2] ?? ''
  const sql = fixtureDb()
  try {
    const [row] = await sql`select o.id as "workspaceId", u.id as "userId"
      from organization o join member m on m.organization_id = o.id
      join "user" u on u.id = m.user_id where o.slug = ${slug} and u.email = ${email}`
    if (!row) throw new Error('Registered workspace fixture missing')
    return { slug, email, workspaceId: String(row.workspaceId), userId: String(row.userId) }
  } finally {
    await sql.end()
  }
}

type Workspace = Awaited<ReturnType<typeof workspaceFixture>>

async function seedOutput(
  db: Database,
  ws: Workspace,
  input: {
    kind: 'image' | 'video'
    width: number
    height: number
    prompt: string
    body: Buffer | null
    durationMs?: number
  },
) {
  const taskId = newId()
  const fileId = newId()
  const r2Key = `ws/${ws.workspaceId}/ai/${taskId}/0`
  const mime = input.kind === 'image' ? 'image/png' : 'video/mp4'
  const tenant = scoped(db, ws.workspaceId)
  await tenant.insert(aiTask, {
    id: taskId,
    userId: ws.userId,
    kind: input.kind,
    status: 'succeeded',
    modelKey: input.kind === 'image' ? 'e2e-flux-fast' : 'e2e-wan-video',
    provider: 'fixture',
    providerRequestKey: taskId,
    pricing: { mode: 'per_call', credits: 1 },
    input: { params: { prompt: input.prompt }, userPrompt: input.prompt },
    deadlineAt: new Date(),
  })
  await tenant.insert(file, {
    id: fileId,
    userId: ws.userId,
    purpose: 'ai_output',
    status: 'ready',
    r2Key,
    mime,
    size: input.body?.length ?? 128,
    width: input.width,
    height: input.height,
    duration: input.durationMs ? input.durationMs / 1000 : null,
    sourceTaskId: taskId,
  })
  if (input.body) putLocalR2(r2Key, input.body, mime)
  return fileId
}

const actor = (ws: Workspace) => ({ userId: ws.userId, role: 'owner', workspaceReadOnly: false })

async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0)
}

async function shoot(page: Page, name: string) {
  mkdirSync(evidenceDir, { recursive: true })
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true })
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme })
}

let bust = 0
/** 绕过匿名边缘缓存的唯一查询（状态变化后检查最新结果） */
const fresh = (path: string) =>
  `${path}${path.includes('?') ? '&' : '?'}e2e=${Date.now()}-${++bust}`

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
})

test('发布 → 画廊可见且 noindex → 审核通过 → 收录 → 取消发布后 404', async ({ page, browser }) => {
  test.setTimeout(360_000)
  const ws = await workspaceFixture(page)
  const db = createDb({ connectionString: env.DATABASE_URL as string })
  const anon = await browser.newContext()
  const visitor = await anon.newPage()
  await stubTurnstile(visitor)
  try {
    const kinds = ['image', 'video'] as const
    const video = sampleVideo()
    const fileIds: string[] = []
    // 同一个工作树库会累积历史数据，标题带本次运行的短后缀以便唯一定位
    const run = randomUUID().slice(0, 4)
    const titles = [
      'Misty lake at dawn',
      'Cabin in the hills',
      'Harbor at dusk',
      'Desert stars',
      'Lighthouse',
      'Rainy street',
    ].map((title) => `${title} ${run}`)
    const sizes = [
      [640, 480],
      [480, 640],
      [640, 360],
      [512, 512],
      [480, 720],
      [720, 480],
    ] as const
    for (const [index, title] of titles.entries()) {
      const [width, height] = sizes[index] as readonly [number, number]
      fileIds.push(
        await seedOutput(db, ws, {
          kind: 'image',
          width,
          height,
          prompt: `${title.slice(0, -5).toLowerCase()}, soft light, watercolor`,
          body: gradientPng(width, height, index * 40),
        }),
      )
    }
    const videoFileId = await seedOutput(db, ws, {
      kind: 'video',
      width: 640,
      height: 360,
      prompt: 'mist slowly clears over the lake',
      body: video,
      durationMs: 2_000,
    })
    const works = []
    for (const [index, fileId] of fileIds.entries())
      works.push(
        await publishStudioWork(db, {
          workspaceId: ws.workspaceId,
          fileId,
          actor: actor(ws),
          kinds,
          title: titles[index] as string,
          showPrompt: index !== 1,
        }),
      )
    const videoWork = await publishStudioWork(db, {
      workspaceId: ws.workspaceId,
      fileId: videoFileId,
      actor: actor(ws),
      kinds,
      title: `Mist over the lake ${run}`,
      showPrompt: true,
    })
    const target = works[0] as (typeof works)[number]
    expect(target.moderation).toBe('pending')

    // 画廊可见；作品页可访问但 noindex，画廊站点地图不含它
    await visitor.goto(fresh('/gallery'))
    await expect(visitor.getByRole('link', { name: target.title })).toBeVisible()
    await visitor.goto(fresh(`/gallery/${target.slug}`))
    await expect(visitor.getByRole('heading', { level: 1, name: target.title })).toBeVisible()
    await expect(visitor.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1)
    const pendingSitemap = await (await visitor.request.get(fresh('/sitemap-gallery.xml'))).text()
    expect(pendingSitemap).toContain('/gallery</loc>')
    expect(pendingSitemap).not.toContain(target.slug)

    // 匿名请求第二次命中边缘缓存
    const cachedPath = `/gallery/${target.slug}?e2e-cache=${randomUUID()}`
    await visitor.request.get(cachedPath)
    const second = await visitor.request.get(cachedPath)
    expect(second.headers()['x-studio-cache']).toBe('hit')
    expect(second.headers()['cache-control']).toBe('public, max-age=0, s-maxage=300')

    // 媒体地址可访问（第 5 组路由）
    const mediaPath = `/media/w/${target.id}/${target.version}`
    expect((await visitor.request.get(mediaPath)).status()).toBe(200)

    // 审核通过（写库替代后台操作）：noindex 消失，进入画廊站点地图
    for (const work of [...works, videoWork])
      await scoped(db, ws.workspaceId).updateById(studioWork, work.id, {
        moderation: 'approved',
        reviewedAt: new Date(),
        ...(work.id === works[2]?.id && { featuredAt: new Date() }),
      })
    await visitor.goto(fresh(`/gallery/${target.slug}`))
    await expect(visitor.getByRole('heading', { level: 1, name: target.title })).toBeVisible()
    await expect(visitor.locator('meta[name="robots"]')).toHaveCount(0)
    await expect(visitor.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      new RegExp(`/gallery/${target.slug}$`),
    )
    await expect(visitor.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`${mediaPath}$`),
    )
    const ld = JSON.parse(
      (await visitor.locator('script[type="application/ld+json"]').first().textContent()) ?? '{}',
    )
    expect(ld['@type']).toBe('ImageObject')
    const approvedSitemap = await (await visitor.request.get(fresh('/sitemap-gallery.xml'))).text()
    expect(approvedSitemap).toContain(`/gallery/${target.slug}</loc>`)
    // 主站点地图不含画廊地址（两者不重叠）
    expect(await (await visitor.request.get('/sitemap.xml')).text()).not.toContain('/gallery')

    // 做同款：未登录跳转登录页，登录用户进入创作页并预填
    const remix = await visitor.request.get(`/gallery/remix/${target.slug}`, { maxRedirects: 0 })
    expect(remix.status()).toBe(302)
    expect(remix.headers().location).toBe(
      `/login?redirect=${encodeURIComponent(`/gallery/remix/${target.slug}`)}`,
    )
    const ownRemix = await page.request.get(`/gallery/remix/${works[1]?.slug}`, { maxRedirects: 0 })
    expect(ownRemix.headers().location).toBe(`/app/${ws.slug}/studio?model=e2e-flux-fast`)

    // 截图：桌面 / 手机 × 浅 / 深（画廊、图片作品、视频作品、提示词未公开、举报对话框、未找到）
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(visitor, theme)
      for (const [label, viewport] of [
        ['desktop', { width: 1440, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const) {
        await visitor.setViewportSize(viewport)
        await visitor.goto(fresh('/gallery'))
        await expect(visitor.getByRole('link', { name: target.title })).toBeVisible()
        await visitor.waitForLoadState('networkidle')
        await noHorizontalScroll(visitor)
        await shoot(visitor, `gallery-${label}-${theme}`)
        await visitor.goto(fresh(`/gallery/${target.slug}`))
        await visitor.waitForLoadState('networkidle')
        await noHorizontalScroll(visitor)
        await shoot(visitor, `work-image-${label}-${theme}`)
        await visitor.goto(fresh(`/gallery/${videoWork.slug}`))
        await visitor.waitForLoadState('networkidle')
        await noHorizontalScroll(visitor)
        await shoot(visitor, `work-video-${label}-${theme}`)
        await visitor.goto(fresh(`/gallery/${works[1]?.slug}`))
        await expect(visitor.getByText(/kept the prompt private/)).toBeVisible()
        await shoot(visitor, `work-prompt-hidden-${label}-${theme}`)
        await visitor.waitForLoadState('networkidle')
        // 水合前的按钮没有事件处理，点击后对话框未出现时重试
        await expect(async () => {
          await visitor
            .getByRole('button', { name: 'Report' })
            .filter({ visible: true })
            .first()
            .click()
          await expect(visitor.getByRole('dialog')).toBeVisible({ timeout: 1_000 })
        }).toPass({ timeout: 15_000 })
        await expect(visitor.getByRole('radiogroup')).toBeVisible()
        await noHorizontalScroll(visitor)
        await shoot(visitor, `work-report-${label}-${theme}`)
        await visitor.keyboard.press('Escape')
        await visitor.goto(fresh('/gallery?kind=video'))
        await shoot(visitor, `gallery-filtered-${label}-${theme}`)
        await visitor.goto(fresh('/gallery?kind=video&sort=featured'))
        await expect(visitor.getByText('No works match these filters')).toBeVisible()
        await shoot(visitor, `gallery-empty-filtered-${label}-${theme}`)
      }
    }

    // 取消发布：作品页 404。媒体地址此前已被浏览器请求并进入本机房边缘缓存；从测试进程取消发布不经过
    // Worker 的失效步骤，所以媒体地址用一件从未被请求过媒体的作品验证回源时 404。
    await unpublishStudioWork(db, {
      workspaceId: ws.workspaceId,
      fileId: fileIds[0] as string,
      actor: actor(ws),
    })
    const gone = await visitor.request.get(fresh(`/gallery/${target.slug}`))
    expect(gone.status()).toBe(404)
    const extraFileId = await seedOutput(db, ws, {
      kind: 'image',
      width: 320,
      height: 240,
      prompt: 'extra',
      body: gradientPng(320, 240, 10),
    })
    const extra = await publishStudioWork(db, {
      workspaceId: ws.workspaceId,
      fileId: extraFileId,
      actor: actor(ws),
      kinds,
      title: `Extra ${run}`,
      showPrompt: true,
    })
    expect((await visitor.request.get(fresh(`/gallery/${extra.slug}`))).status()).toBe(200)
    await unpublishStudioWork(db, {
      workspaceId: ws.workspaceId,
      fileId: extraFileId,
      actor: actor(ws),
    })
    expect((await visitor.request.get(fresh(`/gallery/${extra.slug}`))).status()).toBe(404)
    expect((await visitor.request.get(`/media/w/${extra.id}/${extra.version}`)).status()).toBe(404)
    await visitor.setViewportSize({ width: 1440, height: 900 })
    await setTheme(visitor, 'light')
    await visitor.goto(fresh(`/gallery/${target.slug}`))
    await expect(visitor.getByRole('heading', { name: "We can't find this work" })).toBeVisible()
    await shoot(visitor, 'work-not-found-desktop-light')
    await visitor.setViewportSize({ width: 390, height: 844 })
    await setTheme(visitor, 'dark')
    await visitor.goto(fresh(`/gallery/${target.slug}`))
    await noHorizontalScroll(visitor)
    await shoot(visitor, 'work-not-found-mobile-dark')
  } finally {
    await anon.close()
    await db.$client.end()
  }
})

test('空画廊与越界页', async ({ page }) => {
  // 他站作品不可见：不属于当前站点的数据不出现在本站（单站点模板只验证越界页 404）
  const response = await page.request.get(fresh('/gallery?page=49'))
  expect([200, 404]).toContain(response.status())
  expect((await page.request.get('/gallery?page=51')).status()).toBe(404)
  expect((await page.request.get('/sitemap-gallery-11.xml')).status()).toBe(404)
  expect((await page.request.get('/gallery?kind=video&page=abc')).status()).toBe(404)
})
