import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, type Route, test } from '@playwright/test'
import { grant } from '@saas/credits'
import { createDb } from '@saas/db'
import { readLocalEnv } from '@saas/db/worktree-env'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { newId } from '@saas/shared'
import templateConfig from '../../../template.config.ts'
import { reply, requestData } from './billing-actions-helper.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { chooseOption } from './select.ts'
import { stubTurnstile } from './turnstile.ts'

// 创作页与我的作品（openspec add-media-studio 8.1–8.3）：真实本地认证、空间、页面 loader、发布 / 取消发布 / 删除
// Server Function 与数据库；只有 submitStudio 由测试替身代替服务商（直接写入任务与输出文件，与工作流完成时的数据一致），
// 文件预览由浏览器路由返回占位图，不需要 R2 与服务商凭据。
test.skip(!templateConfig.plugins.studio, 'The studio plugin is disabled')

const studio = templateConfig.plugins.studio as { kinds?: string[] } | undefined
const kinds = (studio?.kinds ?? ['image', 'video']).filter(
  (kind) => templateConfig.ai[kind as 'image' | 'video'],
)
const EVIDENCE = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'add-media-studio/group-8',
)

// 中性占位图（渐变），截图比 1×1 像素更接近真实结果的版面
const PREVIEW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d4d4d8"/><stop offset="1" stop-color="#71717a"/></linearGradient></defs>
<rect width="1024" height="1024" fill="url(#g)"/><circle cx="720" cy="300" r="120" fill="#fafafa" opacity=".6"/>
<path d="M0 820 L320 520 L560 760 L760 600 L1024 860 V1024 H0Z" fill="#3f3f46" opacity=".7"/></svg>`

test.beforeEach(async ({ page }) => {
  await simulateClientIp(page)
  await stubTurnstile(page)
  // 空间文件接口与公开媒体地址都返回占位图（本地 R2 没有对应对象）
  for (const pattern of ['**/api/files/**', '**/media/w/**'])
    await page.route(pattern, (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: PREVIEW_SVG }),
    )
})

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    await page.screenshot({ path: info.outputPath('failure.png'), fullPage: true })
})

function actionDb() {
  const url = readLocalEnv('DATABASE_URL')
  if (!url || !/^\/saas_wt_[a-z0-9_]+$/.test(new URL(url).pathname))
    throw new Error('Studio e2e requires an isolated worktree database')
  return createDb({ connectionString: url })
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
    return { slug, workspaceId: String(row.workspaceId), userId: String(row.userId) }
  } finally {
    await sql.end()
  }
}

async function grantCredits(workspaceId: string, amount: number) {
  const db = actionDb()
  try {
    await grant(db, { workspaceId, source: 'admin', sourceRef: `e2e-studio:${newId()}`, amount })
  } finally {
    await db.$client.end()
  }
}

/** 套餐只授权本测试的两个模型；图片模型无参考图，视频模型以图生视频（参考图必填）。 */
async function seedStudioModels(workspaceId: string) {
  const sql = fixtureDb()
  const suffix = randomUUID().slice(0, 8)
  const image = { key: `e2e-studio-image-${suffix}`, id: newId(), name: `E2E Image ${suffix}` }
  const video = { key: `e2e-studio-video-${suffix}`, id: newId(), name: `E2E Video ${suffix}` }
  const planId = newId()
  const priceId = newId()
  const subscriptionId = newId()
  try {
    await sql`insert into plan (id,key,name,type,credits,features,sort,active)
      values (${planId},${`e2e-studio-${suffix}`},'E2E studio','subscription',0,
        ${sql.json({ ...DEFAULT_FREE_FEATURES, models: [image.key, video.key] })},1000,false)`
    await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
      values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
    await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
      provider_subscription_id,status,current_period_start,current_period_end,
      cancel_at_period_end,canceled_at,last_event_at)
      values (${subscriptionId},${workspaceId},${planId},${priceId},'stripe',${`e2e:${planId}`},
        'canceled',now(),now()+interval '1 day',true,now(),now())`
    await sql`insert into ai_model (id,key,kind,provider,provider_model_id,display_name,pricing,
      min_plan_features,params_schema,sort)
      values (${image.id},${image.key},'image','fal','fal-ai/e2e-image',${image.name},
        ${sql.json({ mode: 'per_call', credits: 4 })},${sql.json([image.key])},
        ${sql.json({
          type: 'object',
          properties: {
            prompt: { type: 'string', title: 'Prompt', minLength: 1 },
            aspect_ratio: {
              type: 'string',
              title: 'Aspect ratio',
              enum: ['1:1', '16:9'],
              default: '1:1',
            },
            seed: { type: 'integer', title: 'Seed', minimum: 0 },
          },
          required: ['prompt'],
        })},-1000)`
    await sql`insert into ai_model (id,key,kind,provider,provider_model_id,display_name,pricing,
      min_plan_features,params_schema,sort)
      values (${video.id},${video.key},'video','fal','fal-ai/e2e-video',${video.name},
        ${sql.json({ mode: 'per_call', credits: 20 })},${sql.json([video.key])},
        ${sql.json({
          type: 'object',
          properties: {
            prompt: { type: 'string', title: 'Prompt', minLength: 1 },
            image_url: { type: 'string', title: 'Image', format: 'file' },
            resolution: {
              type: 'string',
              title: 'Resolution',
              enum: ['480p', '720p'],
              default: '720p',
            },
          },
          required: ['prompt', 'image_url'],
        })},-1000)`
  } finally {
    await sql.end()
  }
  return {
    image,
    video,
    async cleanup() {
      const sql = fixtureDb()
      try {
        await sql`delete from ai_model where id in ${sql([image.id, video.id])}`
        await sql`delete from subscription where id = ${subscriptionId}`
        await sql`delete from plan_price where id = ${priceId}`
        await sql`delete from plan where id = ${planId}`
      } finally {
        await sql.end()
      }
    },
  }
}

/** 模型注册表有 60 秒 KV 缓存：重载页面直到创作页列出本测试的模型。 */
async function openStudio(page: Page, path: string, modelName: string) {
  await expect(async () => {
    await page.goto(path)
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible({
      timeout: 2_000,
    })
    const trigger = page.getByRole('combobox', { name: 'Model', exact: true })
    if (!(await trigger.textContent())?.includes(modelName)) await chooseOption(trigger, modelName)
    await expect(trigger).toContainText(modelName, { timeout: 1_000 })
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] })
}

interface FakeTask {
  taskId: string
  fileId: string
}

/**
 * 测试替身：拦截 submitStudio（带 mode 与 modelKey 的 Server Function POST），按提交内容写入 running 任务，
 * 由用例调用 finish 写入成功状态与输出文件。其余 Server Function 照常发往开发服务器。
 */
async function fakeProvider(page: Page, workspace: { workspaceId: string; userId: string }) {
  const submitted: Record<string, unknown>[] = []
  const tasks: (FakeTask & { kind: 'image' | 'video' })[] = []
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const data = requestData(route) as Record<string, unknown>
    if (!('modelKey' in data && 'mode' in data && 'prompt' in data)) return route.fallback()
    submitted.push(data)
    const kind = data.mode as 'image' | 'video'
    const task = { taskId: newId(), fileId: newId(), kind }
    const sql = fixtureDb()
    try {
      await sql`insert into ai_task (id,workspace_id,user_id,kind,model_key,pricing,status,input,
        provider,provider_request_key,started_at,deadline_at)
        values (${task.taskId},${workspace.workspaceId},${workspace.userId},${kind},
          ${String(data.modelKey)},${sql.json({ mode: 'per_call', credits: kind === 'image' ? 4 : 20 })},
          'running',${sql.json({ params: { ...(data.params as Record<string, string>), prompt: String(data.prompt) }, userPrompt: String(data.prompt) })},
          'fal',${task.taskId},now(),now()+interval '2 hours')`
    } finally {
      await sql.end()
    }
    tasks.push(task)
    await reply(route, { ok: true, taskId: task.taskId, status: 'running' })
  }
  await page.route('**/_serverFn/**', handler)
  return {
    submitted,
    tasks,
    async finish(task: (typeof tasks)[number]) {
      const sql = fixtureDb()
      try {
        await sql`insert into file (id,workspace_id,user_id,purpose,status,r2_key,mime,size,width,height,
          duration,source_task_id)
          values (${task.fileId},${workspace.workspaceId},${workspace.userId},'ai_output','ready',
            ${`ws/${workspace.workspaceId}/ai/${task.taskId}/0`},
            ${task.kind === 'image' ? 'image/png' : 'video/mp4'},2048,
            ${task.kind === 'image' ? 1024 : 1280},${task.kind === 'image' ? 1024 : 720},
            ${task.kind === 'video' ? 5 : null},${task.taskId})`
        const output = {
          id: task.fileId,
          mime: task.kind === 'image' ? 'image/png' : 'video/mp4',
          size: 2048,
          width: task.kind === 'image' ? 1024 : 1280,
          height: task.kind === 'image' ? 1024 : 720,
          duration: task.kind === 'video' ? 5 : null,
        }
        await sql`update ai_task set status='succeeded', credits_charged=${task.kind === 'image' ? 4 : 20},
          output=${sql.json({ files: [output] })}, finished_at=now(), updated_at=now()
          where id=${task.taskId}`
      } finally {
        await sql.end()
      }
    },
    async stop() {
      await page.unroute('**/_serverFn/**', handler)
    },
  }
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const

/** 截图证据：桌面 / 手机 × 浅 / 深，写入 EVIDENCE_DIR，与 docs/design-system/prototypes/media-studio 对照。 */
async function shoot(
  page: Page,
  name: string,
  variants: (keyof typeof VIEWPORTS)[] = ['desktop', 'mobile'],
) {
  mkdirSync(EVIDENCE, { recursive: true })
  const original = page.viewportSize()
  for (const viewport of variants) {
    await page.setViewportSize(VIEWPORTS[viewport])
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(700)
      if (viewport === 'mobile')
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll('body *')]
              .filter((element) => element.getBoundingClientRect().right > 391)
              .slice(0, 5)
              .map((element) => `${element.tagName}.${element.className}`),
          ),
          `${name} elements overflowing 390px`,
        ).toEqual([])
      if (viewport === 'mobile')
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${name} has no horizontal scroll at 390px`,
        ).toBeLessThanOrEqual(390)
      await page.screenshot({
        path: `${EVIDENCE}/${name}-${viewport}-${scheme}.png`,
        fullPage: true,
      })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  if (original) await page.setViewportSize(original)
}

test('creates an image, publishes it, then unpublishes and deletes it in My works', async ({
  page,
}) => {
  test.skip(!kinds.includes('image'), 'Image mode is disabled')
  test.setTimeout(240_000)
  await page.setViewportSize(VIEWPORTS.desktop)
  const workspace = await workspaceFixture(page)
  const models = await seedStudioModels(workspace.workspaceId)
  await grantCredits(workspace.workspaceId, 100)
  const provider = await fakeProvider(page, workspace)
  try {
    // 导航入口：创作在工具分组、我的作品在内容分组
    await page.goto(`/app/${workspace.slug}`)
    const nav = page.getByRole('navigation', { name: /./ }).first()
    await expect(nav.getByRole('link', { name: 'Create', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'My works', exact: true })).toBeVisible()

    await openStudio(page, `/app/${workspace.slug}/studio`, models.image.name)
    await expect(page.getByTestId('studio-balance')).toHaveText('Balance 100')
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled()
    await shoot(page, 'studio-empty')

    await page.getByLabel('Prompt', { exact: true }).fill('A cabin in the mountains at dawn')
    await expect(page.getByTestId('studio-estimate')).toHaveText(
      'Estimated cost 4 credits, not charged if it fails',
    )
    await page.getByRole('button', { name: 'More settings' }).click()
    await expect(page.getByRole('combobox', { name: 'Aspect ratio' })).toBeVisible()
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Generating, usually' })).toBeVisible()
    await shoot(page, 'studio-running', ['desktop'])
    expect(provider.submitted).toEqual([
      expect.objectContaining({
        slug: workspace.slug,
        mode: 'image',
        modelKey: models.image.key,
        prompt: 'A cabin in the mountains at dawn',
        params: { aspect_ratio: '1:1' },
      }),
    ])
    const task = provider.tasks[0]
    if (!task) throw new Error('Fake task missing')
    await provider.finish(task)
    const results = page.getByRole('list', { name: 'Results' })
    await expect(results.getByRole('img', { name: 'Generated result 1' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId('studio-result-meta')).toHaveText('1024 × 1024 · 4 credits used')
    await shoot(page, 'studio-done')

    await results.getByRole('button', { name: 'Publish to gallery' }).click()
    const dialog = page.getByRole('dialog', { name: 'Publish to gallery' })
    await expect(dialog.getByLabel('Title')).toHaveValue('A cabin in the mountains at dawn')
    await expect(dialog.getByTestId('studio-publish-quota')).toHaveText(
      '20 / 20 publications left today',
    )
    await dialog.getByLabel('Title').fill('Mountain cabin')
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(results.getByTestId('studio-result-state')).toHaveText('In review')

    // 我的作品：已公开筛选中显示待审核，取消发布后变为未公开，再删除
    await page.goto(`/app/${workspace.slug}/studio/works?visibility=public`)
    const card = page.getByRole('article', { name: 'Mountain cabin' })
    await expect(card.getByTestId('studio-work-state')).toHaveText('In review')
    await expect(page.getByTestId('studio-works-quota')).toHaveText(
      '19 / 20 publications left today',
    )
    // SSR 首屏先于水合可见：重试点击直到筛选生效
    await expect(async () => {
      await page
        .getByRole('group', { name: 'Visibility' })
        .getByRole('button', { name: 'All' })
        .click()
      await expect(page).toHaveURL(/\/studio\/works$/, { timeout: 1_000 })
    }).toPass({ timeout: 15_000 })
    await shoot(page, 'works')
    await card.getByRole('button', { name: 'Unpublish' }).click()
    await expect(card.getByTestId('studio-work-state')).toHaveText('Private')
    const sql = fixtureDb()
    try {
      const [work] =
        await sql`select visibility, version from studio_work where file_id=${task.fileId}`
      expect(work?.visibility).toBe('private')
    } finally {
      await sql.end()
    }

    // 再次打开发布对话框（取消发布后沿用原标题）作截图证据，然后关闭
    await card.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: 'Publish to gallery' }).getByLabel('Title'),
    ).toHaveValue('Mountain cabin')
    await shoot(page, 'works-publish-dialog', ['desktop'])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.setViewportSize(VIEWPORTS.mobile)
    await page.getByRole('button', { name: 'Work actions: Mountain cabin' }).click()
    await page.getByRole('menuitem', { name: 'Publish' }).click()
    await expect(page.getByRole('dialog', { name: 'Publish to gallery' })).toBeVisible()
    await shoot(page, 'works-publish-sheet', ['mobile'])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.setViewportSize(VIEWPORTS.desktop)

    await card.getByRole('button', { name: 'More actions: Mountain cabin' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Delete this work?' })
    await expect(confirm).toBeVisible()
    await shoot(page, 'works-delete-confirm', ['desktop'])
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'No works yet' })).toBeVisible()
    await shoot(page, 'works-empty')
    const check = fixtureDb()
    try {
      const [row] = await check`select deleted_at from file where id=${task.fileId}`
      expect(row?.deleted_at).not.toBeNull()
      expect(await check`select id from studio_work where file_id=${task.fileId}`).toHaveLength(0)
    } finally {
      await check.end()
    }
  } finally {
    await provider.stop()
    await models.cleanup()
  }
})

test('image-to-video needs a reference image and blocks submission without enough credits', async ({
  page,
}) => {
  test.skip(!kinds.includes('video'), 'Video mode is disabled')
  test.setTimeout(240_000)
  await page.setViewportSize(VIEWPORTS.desktop)
  const workspace = await workspaceFixture(page)
  const models = await seedStudioModels(workspace.workspaceId)
  const referenceId = newId()
  const sql = fixtureDb()
  try {
    await sql`insert into file (id,workspace_id,user_id,purpose,status,r2_key,mime,size,width,height)
      values (${referenceId},${workspace.workspaceId},${workspace.userId},'upload','ready',
        ${`ws/${workspace.workspaceId}/${referenceId}`},'image/png',1258291,1024,1024)`
  } finally {
    await sql.end()
  }
  const provider = await fakeProvider(page, workspace)
  try {
    // 做同款：地址预填模型与提示词，模式随模型切到视频
    const prompt = 'Mist slowly clears over a lake'
    await openStudio(
      page,
      `/app/${workspace.slug}/studio?model=${models.video.key}&prompt=${encodeURIComponent(prompt)}`,
      models.video.name,
    )
    await expect(page.getByRole('tab', { name: 'Video' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(prompt)
    // 余额 0：提示余额不足并给出充值入口，生成按钮不可用
    const alert = page.getByRole('alert').filter({ hasText: 'Not enough credits' })
    await expect(alert).toContainText('this needs 20, you have 0')
    await expect(alert.getByRole('link', { name: 'Top up' })).toHaveAttribute(
      'href',
      `/app/${workspace.slug}/billing#credit-packs`,
    )
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled()
    await shoot(page, 'studio-insufficient')

    await grantCredits(workspace.workspaceId, 100)
    await page.reload()
    await expect(page.getByTestId('studio-balance')).toHaveText('Balance 100')
    await expect(page.getByText('Reference image (required for image-to-video)')).toBeVisible()
    await chooseOption(
      page.getByRole('combobox', { name: 'Reference image (required for image-to-video)' }),
      { value: referenceId },
    )
    await expect(page.getByRole('img', { name: 'Selected reference image' })).toBeVisible()
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Generating, usually' })).toBeVisible()
    expect(provider.submitted).toEqual([
      expect.objectContaining({
        mode: 'video',
        modelKey: models.video.key,
        prompt,
        params: { image_url: referenceId, resolution: '720p' },
      }),
    ])
    const task = provider.tasks[0]
    if (!task) throw new Error('Fake task missing')
    await provider.finish(task)
    const player = page.getByLabel('Generated result 1')
    await expect(player).toBeVisible({ timeout: 15_000 })
    expect(await player.evaluate((element) => element.tagName)).toBe('VIDEO')
    await expect(page.getByTestId('studio-result-meta')).toHaveText(
      '1280 × 720 · 5 s · 20 credits used',
    )
    await shoot(page, 'studio-video')

    // 发布视频后在我的作品中显示时长角标
    await page.getByRole('button', { name: 'Publish to gallery' }).click()
    const dialog = page.getByRole('dialog', { name: 'Publish to gallery' })
    await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByTestId('studio-result-state')).toHaveText('In review')
    await page.goto(`/app/${workspace.slug}/studio/works?kind=video`)
    const card = page.getByRole('article', { name: prompt })
    await expect(card.getByText('0:05')).toBeVisible()
    await expect(card.getByTestId('studio-work-state')).toHaveText('In review')
  } finally {
    await provider.stop()
    await models.cleanup()
  }
})
