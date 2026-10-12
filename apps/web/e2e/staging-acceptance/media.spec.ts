import type { Page } from '@playwright/test'
import {
  awaitTerminal,
  mediaWorkspace,
  recordMedia,
  reuseOrSubmit,
  verifyMediaAccounting,
} from './media-support.ts'
import { falImage, falVideo, verifyAcceptanceModel, workersImage } from './models.ts'
import { evidence, expect, login, query, sqlLiteral, test } from './support.ts'

async function requireMediaModel(model: typeof workersImage | typeof falImage | typeof falVideo) {
  const existing = await query<{ id: string }>(
    `select id from ai_model where key = ${sqlLiteral(model.key)}`,
  )
  test.skip(existing.length === 0, `先完成 models setup：${model.key} 尚未配置`)
  await verifyAcceptanceModel(model)
}

async function loginMedia(page: Page) {
  test.skip(!process.env.NEON_READONLY_URL, '媒体验收需要 NEON_READONLY_URL 只读对账及幂等恢复')
  await login(page, 'user')
}

for (const [step, model] of [
  ['media-workers-image', workersImage],
  ['media-fal-image', falImage],
] as const) {
  test(`${step}：成功下载、按快照扣款一次及积分对账`, async ({ page }) => {
    test.setTimeout(22 * 60_000)
    await loginMedia(page)
    await requireMediaModel(model)
    const workspace = await mediaWorkspace(page)
    const submitted = await reuseOrSubmit(page, workspace, model, step)
    const task = await awaitTerminal(page, workspace.workspaceId, submitted.taskId)
    await evidence(`${step}-terminal`, {
      taskId: task.id,
      workspaceId: task.workspaceId,
      status: task.status,
      errorCode: task.errorCode,
      reused: submitted.reused,
    })
    expect(task.status).toBe('succeeded')
    expect(task.files.length).toBeGreaterThan(0)
    for (const file of task.files) {
      // 下载响应仅检查状态与字节，预签名地址及请求头不写入证据。
      const download = await page.request
        .get(`/api/files/${file.id}?workspaceId=${workspace.workspaceId}`)
        .catch(() => null)
      if (!download) throw new Error('媒体下载失败；检查 R2 访问配置')
      expect(download.status()).toBe(200)
      expect((await download.body()).byteLength).toBe(file.size)
      expect(file.size).toBeGreaterThan(0)
    }
    const accounting = await verifyMediaAccounting(
      workspace.workspaceId,
      task.id,
      'succeeded',
      model.pricing.credits as number,
    )
    await recordMedia(step, task, submitted.reused, accounting)
  })
}

test('media-fal-video-cancel：提交后立即取消并全额退回', async ({ page }) => {
  test.setTimeout(3 * 60_000)
  await loginMedia(page)
  await requireMediaModel(falVideo)
  const workspace = await mediaWorkspace(page)
  const step = 'media-fal-video-cancel'
  const submitted = await reuseOrSubmit(page, workspace, falVideo, step)
  // 新任务不先等待运行态；重跑调用同一取消接口也不会重复退款。
  const canceled = await page.request
    .post(`/api/ai/tasks/${submitted.taskId}/cancel`, {
      data: { workspaceId: workspace.workspaceId },
    })
    .catch(() => null)
  if (!canceled) throw new Error('取消请求结果不确定；重跑同一 run ID 复用原任务')
  expect([200, 202]).toContain(canceled.status())
  const cancellation = (await canceled.json()) as { status: string; cancellationPending: boolean }
  await evidence(`${step}-response`, {
    taskId: submitted.taskId,
    workspaceId: workspace.workspaceId,
    status: cancellation.status,
    cancellationPending: cancellation.cancellationPending,
    reused: submitted.reused,
  })
  expect(cancellation.status, '若视频已经生成完成，本次无法作为取消退款验收证据').toBe('canceled')
  const task = await awaitTerminal(page, workspace.workspaceId, submitted.taskId)
  const accounting = await verifyMediaAccounting(
    workspace.workspaceId,
    task.id,
    'canceled',
    falVideo.pricing.credits as number,
  )
  await recordMedia(step, task, submitted.reused, accounting)
  expect(
    cancellation.cancellationPending,
    '积分已退回，但外部取消尚未确认；同一 run ID 重跑恢复',
  ).toBe(false)
})

test('media-workers-provider-failure：人工验证推理失败全额退回', async () => {
  test.skip(true, '暂无可靠的参数能通过本站校验且使真实 Workers AI 失败；按 runbook 人工注入')
})
