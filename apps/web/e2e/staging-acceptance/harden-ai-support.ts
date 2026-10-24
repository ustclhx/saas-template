import { readFileSync } from 'node:fs'
import type { APIResponse, Page } from '@playwright/test'
import type { Pricing } from '@saas/ai'
import { guidancePrefix } from './accounts.ts'
import type { FaultModelDefinition } from './fault-definitions.ts'
import type { FaultWorkspace } from './fault-readiness.ts'
import { evidence, expect, local, query, reconcile, runId, sqlLiteral } from './support.ts'

/**
 * harden-audit-findings 7.3 的 AI 验收（免费失败第 4 次扣费、媒体取消三种情况、不确定提交）。
 * 故障模型只对平台管理员开放且模板为单租户，所以场景都在管理员个人空间执行：本地每次新建管理员与空间，
 * staging 用只读查询确认该空间的计数前提，不满足时报告「无法确认」而不是让结果依赖历史数据。
 * 三种结论：通过；断言失败（产品行为与规格不符）；`[无法确认]`（前提不满足或竞态，未得出结论）。
 */

export class Inconclusive extends Error {}
export async function inconclusive(
  name: string,
  reason: string,
  data: Record<string, unknown> = {},
): Promise<never> {
  await evidence(name, { result: 'inconclusive', reason, ...data })
  throw new Inconclusive(`[无法确认] ${reason}`)
}
function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`${guidancePrefix}harden-ai 核验：${message}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** UUIDv7 前 48 位为毫秒时间戳，与结算计数（design D1）使用同一时间口径。 */
export const uuidMs = (id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
const uuidFloor = (ms: number) => {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').slice(-12)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`
}
async function dbNow() {
  const [row] = await query<{ now: string }>('select now() as now')
  return Date.parse(row?.now ?? '')
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await sleep(intervalMs)
  }
}

type Ledger = { type: string; delta: number }
const holdSql = `h.id as "holdId", h.status as "holdStatus", h.amount as held,
  h.captured_amount as captured, h.overage_debited as debited, h.overage_debt as debt,
  h.overage_absorbed as absorbed`
const ledgerSql = (workspaceId: string, refType: string, id: string) =>
  `coalesce((select json_agg(json_build_object('type',l.type,'delta',l.delta) order by l.id)
    from credit_ledger l where l.workspace_id=${sqlLiteral(workspaceId)} and l.ref_type=${sqlLiteral(refType)}
    and l.ref_id=${id}::text),'[]'::json) as ledger`

type Hold = {
  holdId: string | null
  holdStatus: string | null
  held: number
  captured: number
  debited: number
  debt: number
  absorbed: number
  ledger: Ledger[]
}
/** 精确核对一次结算：扣费额、预扣状态、消费账本次数与合计，且不产生补扣、欠费或平台吸收。 */
function checkSettlement(row: Hold, charge: number, label: string) {
  must(row.holdId, `${label} 缺少预扣`)
  must(
    row.holdStatus === (charge > 0 ? 'captured' : 'released'),
    `${label} 预扣状态 ${row.holdStatus}，应为 ${charge > 0 ? 'captured' : 'released'}`,
  )
  must(row.captured === charge, `${label} 实扣 ${row.captured}，应为 ${charge}`)
  must(charge <= row.held, `${label} 扣费 ${charge} 超过预扣 ${row.held}`)
  must(row.debited === 0 && row.debt === 0 && row.absorbed === 0, `${label} 出现补扣、欠费或吸收`)
  const consumes = row.ledger.filter((entry) => entry.type === 'consume')
  must(consumes.length === (charge > 0 ? 1 : 0), `${label} 消费账本 ${consumes.length} 条`)
  const total = row.ledger.reduce((sum, entry) => sum + entry.delta, 0)
  must(total === -charge, `${label} 账本合计 ${total}，应为 ${-charge}`)
}

// ---------------------------------------------------------------- 免费失败（ai-text-reasoning / D1）

export type FreeFailurePolicy = { count: number; windowSeconds: number }
export const DEFAULT_FREE_FAILURES: FreeFailurePolicy = { count: 3, windowSeconds: 3600 }
const TEXT_PROMPT = 'Acceptance free failure check: describe a red square in one sentence.'
// 与 fault-support 相同的输入估算口径：tokensPerChar=1，外加 8 个消息开销 token。
const TEXT_INPUT_TOKENS = [...TEXT_PROMPT].length + 8

export async function readFreeFailurePolicy(): Promise<{
  value: FreeFailurePolicy
  stored: boolean
}> {
  const [row] = await query<{ value: FreeFailurePolicy }>(
    `select value from setting where key='ai.freeFailures'`,
  )
  return row ? { value: row.value, stored: true } : { value: DEFAULT_FREE_FAILURES, stored: false }
}

/** 经后台设置页保存；结算在事务内直读设置表（不经 KV 缓存），保存后立即对下一次结算生效。 */
export async function saveFreeFailurePolicy(page: Page, value: FreeFailurePolicy) {
  if (value.windowSeconds % 60 !== 0)
    throw new Error(`${guidancePrefix}后台设置页以分钟保存窗口，无法写入 ${value.windowSeconds} 秒`)
  await page.goto('/admin/settings')
  const form = page.getByRole('form', { name: 'Runtime settings', exact: true })
  const save = form.getByRole('button', { name: 'Save settings', exact: true })
  await expect(save).toBeEnabled()
  await form
    .getByLabel('Free failed AI replies per workspace', { exact: true })
    .fill(String(value.count))
  await form
    .getByLabel('Free failure window (minutes)', { exact: true })
    .fill(String(value.windowSeconds / 60))
  await save.click()
  await expect(
    page.getByText('Saved. Changes apply within about 60 seconds.', { exact: true }),
  ).toBeVisible()
  await expect.poll(async () => (await readFreeFailurePolicy()).value).toEqual(value)
}

export async function settingAudits(sinceMs: number) {
  return query<{ id: string }>(`select id from audit_log where action='setting.updated'
    and target_id='ai.freeFailures' and id >= ${sqlLiteral(uuidFloor(sinceMs))} order by id`)
}

/** 与结算相同的计数口径：窗口内 `status='failed' and credits=0` 的 assistant 回复。 */
async function freeFailures(workspaceId: string, windowSeconds: number) {
  const now = await dbNow()
  const rows = await query<{ id: string }>(`select id from ai_message
    where workspace_id=${sqlLiteral(workspaceId)} and role='assistant' and status='failed' and credits=0
    and id >= ${sqlLiteral(uuidFloor(now - windowSeconds * 1000))} order by id`)
  return { now, ids: rows.map((row) => row.id) }
}

/** 等到窗口内不再有免费失败（只读轮询），用于窗口滚动；超出上限返回 false。 */
export async function waitFreeFailuresExpire(
  workspaceId: string,
  windowSeconds: number,
  maxWaitMs: number,
) {
  const { now, ids } = await freeFailures(workspaceId, windowSeconds)
  const latest = Math.max(0, ...ids.map(uuidMs))
  const waitMs = latest ? latest + windowSeconds * 1000 + 5_000 - now : 0
  if (waitMs > maxWaitMs) return false
  if (waitMs > 0) await sleep(waitMs)
  return (await freeFailures(workspaceId, windowSeconds)).ids.length === 0
}

type TextRow = Hold & {
  id: string
  status: string
  modelKey: string
  pricing: Pricing
  credits: number | null
  inputTokens: number | null
  outputTokens: number | null
  failedReplyRefund: string | null
  lastInputTokens: number | null
  lastOutputTokens: number | null
  proofMode: string | null
  proofInjected: boolean | null
  realProviderCalled: boolean | null
  upstreamCalls: number | null
  charCount: number
}

async function textSnapshot(workspaceId: string, conversationId: string) {
  const ws = sqlLiteral(workspaceId)
  const cid = sqlLiteral(conversationId)
  const [snapshot] = await query<{
    messageCount: number
    userCount: number
    rows: TextRow[]
  }>(`select
    (select count(*)::int from ai_message where workspace_id=${ws} and conversation_id=${cid}) as "messageCount",
    (select count(*)::int from ai_message where workspace_id=${ws} and conversation_id=${cid} and role='user') as "userCount",
    coalesce((select json_agg(r) from (select m.id, m.status, m.model_key as "modelKey", m.pricing, m.credits,
      m.input_tokens as "inputTokens", m.output_tokens as "outputTokens",
      m.usage_checkpoint->>'failedReplyRefund' as "failedReplyRefund",
      (m.usage_checkpoint->'lastAttempt'->>'inputTokens')::int as "lastInputTokens",
      (m.usage_checkpoint->'lastAttempt'->>'outputTokens')::int as "lastOutputTokens",
      m.usage_checkpoint->'acceptanceFaultProof'->>'mode' as "proofMode",
      (m.usage_checkpoint->'acceptanceFaultProof'->>'injected')::boolean as "proofInjected",
      (m.usage_checkpoint->'acceptanceFaultProof'->>'realProviderCalled')::boolean as "realProviderCalled",
      (m.usage_checkpoint->'acceptanceFaultProof'->>'upstreamCalls')::int as "upstreamCalls",
      coalesce((select sum(length(p->>'text'))::int from jsonb_array_elements(m.parts) p where p->>'type'='text'),0) as "charCount",
      ${holdSql}, ${ledgerSql(workspaceId, 'ai_message', 'm.id')}
      from ai_message m left join credit_hold h on h.id=m.hold_id and h.workspace_id=m.workspace_id
      where m.workspace_id=${ws} and m.conversation_id=${cid} and m.role='assistant') r),'[]'::json) as rows`)
  must(snapshot, '文本快照缺失')
  return snapshot
}

/** 经产品 UI 新建对话并发送一次；故障模型在流开始前失败，不调用真实上游。 */
async function failOnce(page: Page, workspace: FaultWorkspace, model: FaultModelDefinition) {
  await page.goto(`/app/${workspace.slug}/chat`)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/)
  const conversationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  // 模型列表有缓存，新启用的故障模型可能稍后才出现。
  await expect
    .poll(
      async () => {
        const options = await page
          .getByLabel('Model', { exact: true })
          .locator('option[value]')
          .allTextContents()
        if (!options.includes(model.key)) await page.reload()
        return options
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toContain(model.key)
  await page.getByLabel('Model', { exact: true }).selectOption({ label: model.key })
  await page.getByLabel('Message', { exact: true }).fill(TEXT_PROMPT)
  // 只点击一次；之后只读等待终态，不重新发送。
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const snapshot = await until(async () => {
    const value = await textSnapshot(workspace.workspaceId, conversationId)
    return ['failed', 'completed', 'aborted'].includes(value.rows[0]?.status ?? '')
      ? value
      : undefined
  }, 180_000)
  must(snapshot, `对话 ${conversationId} 未在 180 秒内结束`)
  return { conversationId, snapshot }
}

/** 一组：同一空间、同一窗口内连续 4 次无可见正文的失败；前 `count` 次全退，之后按最后一次尝试结算。 */
export async function runFreeFailureGroup(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
  policy: FreeFailurePolicy,
  name: string,
) {
  const pre = await freeFailures(workspace.workspaceId, policy.windowSeconds)
  if (pre.ids.length !== 0)
    await inconclusive(
      name,
      `空间 ${workspace.workspaceId} 在 ${policy.windowSeconds} 秒窗口内已有 ${pre.ids.length} 次免费失败；` +
        `请在 ${new Date(Math.max(...pre.ids.map(uuidMs)) + policy.windowSeconds * 1000).toISOString()} 之后重跑`,
      { workspaceId: workspace.workspaceId, existing: pre.ids },
    )
  const pricing = model.pricing
  const maxOutputTokens = (model.paramsSchema['x-text'] as { maxOutputTokens: number })
    .maxOutputTokens
  let held: number
  let charge: number
  if (pricing.mode === 'per_call') {
    held = pricing.credits
    charge = pricing.credits
  } else if (pricing.mode === 'token') {
    const min = pricing.minCharge ?? 1
    held = Math.max(
      Math.ceil(
        (TEXT_INPUT_TOKENS * pricing.inputPer1k + maxOutputTokens * pricing.outputPer1k) / 1000,
      ),
      min,
    )
    // 流前失败的最后一次尝试只有输入估算、没有输出，按用量计算后不低于 minCharge。
    charge = Math.min(
      held,
      Math.max(Math.ceil((TEXT_INPUT_TOKENS * pricing.inputPer1k) / 1000), min),
    )
  } else throw new Error('Unsupported text pricing')
  const attempts = []
  for (let index = 1; index <= policy.count + 1; index++) {
    const before = await freeFailures(workspace.workspaceId, policy.windowSeconds)
    must(before.ids.length === index - 1, `第 ${index} 次前窗口内免费失败为 ${before.ids.length}`)
    const { conversationId, snapshot } = await failOnce(page, workspace, model)
    const row = snapshot.rows[0]
    must(snapshot.rows.length === 1 && row, `对话 ${conversationId} 缺失或重复 assistant`)
    const label = `第 ${index} 次（消息 ${row.id}）`
    must(snapshot.messageCount === 2 && snapshot.userCount === 1, `${label} 消息数不匹配`)
    must(row.modelKey === model.key && row.status === 'failed', `${label} 状态 ${row.status}`)
    expect(row.pricing, `${label} 定价快照`).toEqual(pricing)
    must(
      row.proofMode === 'chat-before-stream' &&
        row.proofInjected === true &&
        row.realProviderCalled === false &&
        row.upstreamCalls === 0,
      `${label} 缺少流前故障注入证明或调用了真实上游`,
    )
    must(row.charCount === 0, `${label} 出现可见正文`)
    if (row.failedReplyRefund !== 'no-visible-output')
      await inconclusive(
        name,
        `失败全退开关为 ${row.failedReplyRefund}，本场景需要 no-visible-output`,
        {
          messageId: row.id,
        },
      )
    must(row.held === held, `${label} 预扣 ${row.held}，应为 ${held}`)
    must(
      row.lastInputTokens === TEXT_INPUT_TOKENS && row.lastOutputTokens === 0,
      `${label} 最后一次尝试用量 ${row.lastInputTokens}/${row.lastOutputTokens}`,
    )
    const free = index <= policy.count
    if (
      !free &&
      uuidMs(row.id) - uuidMs(attempts[0]?.messageId ?? row.id) >= policy.windowSeconds * 1000
    )
      await inconclusive(name, `${policy.count + 1} 次失败跨越了 ${policy.windowSeconds} 秒窗口`, {
        attempts,
      })
    const expected = free ? 0 : charge
    must(row.credits === expected, `${label} credits=${row.credits}，应为 ${expected}`)
    checkSettlement(row, expected, label)
    if (!free)
      must(
        row.inputTokens === TEXT_INPUT_TOKENS && row.outputTokens === 0,
        `${label} 收费用量应与最后一次尝试一致`,
      )
    attempts.push({
      index,
      conversationId,
      messageId: row.id,
      freeFailuresBefore: before.ids.length,
      held: row.held,
      credits: row.credits,
      captured: row.captured,
      releasedCredits: row.held - row.captured,
      holdStatus: row.holdStatus,
      ledger: row.ledger,
      lastAttempt: { inputTokens: row.lastInputTokens, outputTokens: row.lastOutputTokens },
      failedReplyRefund: row.failedReplyRefund,
    })
  }
  const reconciliation = await reconcile(workspace.workspaceId)
  const result = {
    result: 'passed',
    workspaceId: workspace.workspaceId,
    modelKey: model.key,
    pricing,
    policy,
    expected: { held, freeAttempts: policy.count, chargedAttempt: policy.count + 1, charge },
    spanMs: uuidMs(attempts.at(-1)?.messageId ?? '') - uuidMs(attempts[0]?.messageId ?? ''),
    attempts,
    reconciliation,
  }
  await evidence(name, result)
  return result
}

// ---------------------------------------------------------------- 媒体取消（ai-media-tasks / D2）

const mediaMessages = JSON.parse(
  readFileSync(new URL('../../messages/en/ai-media-tasks.json', import.meta.url), 'utf8'),
) as Record<string, string>
const copy = (key: string, credits?: number) => {
  const value = mediaMessages[key]
  if (!value) throw new Error(`Missing message ${key}`)
  return credits === undefined ? value : value.replace('{credits}', String(credits))
}

export type CancelPreview = {
  taskId: string
  cancelable: boolean
  started: boolean
  charged: boolean
  credits: number
  freeStartedRemaining: number
}
type TaskRow = Hold & {
  id: string
  status: string
  modelKey: string
  pricing: Pricing
  creditsCharged: number | null
  cancelBilling: string | null
  errorCode: string | null
  providerJobId: string | null
  deadlineAt: string
  proofMode: string | null
  proofInjected: boolean | null
  realProviderCalled: boolean | null
  submitAttempts: number | null
  cancellation: string | null
}

export async function taskSnapshot(workspace: FaultWorkspace, taskId: string) {
  const [row] = await query<TaskRow>(`select t.id, t.status, t.model_key as "modelKey", t.pricing,
    t.credits_charged as "creditsCharged", t.cancel_billing as "cancelBilling", t.error_code as "errorCode",
    t.provider_job_id as "providerJobId", t.deadline_at as "deadlineAt",
    t.input->'acceptanceFaultProof'->>'mode' as "proofMode",
    (t.input->'acceptanceFaultProof'->>'injected')::boolean as "proofInjected",
    (t.input->'acceptanceFaultProof'->>'realProviderCalled')::boolean as "realProviderCalled",
    (t.input->'acceptanceFaultProof'->>'submitAttempts')::int as "submitAttempts",
    t.input->'acceptanceFaultProof'->'cancellation'->>'status' as cancellation,
    ${holdSql}, ${ledgerSql(workspace.workspaceId, 'ai_task', 't.id')}
    from ai_task t left join credit_hold h on h.id=t.hold_id and h.workspace_id=t.workspace_id
    where t.workspace_id=${sqlLiteral(workspace.workspaceId)} and t.user_id=${sqlLiteral(workspace.userId)}
    and t.id=${sqlLiteral(taskId)}`)
  must(row, `任务 ${taskId} 不存在`)
  return row
}

export async function freeStartedRemaining(workspaceId: string) {
  const [row] = await query<{ used: number }>(`select count(*)::int as used from ai_task
    where workspace_id=${sqlLiteral(workspaceId)} and cancel_billing='free_started'`)
  return (row?.used ?? 0) > 0 ? 0 : 1
}

/**
 * 经 HTTP 提交并按提示词标记定位任务。staging 的 Workflow 异步执行，响应立即返回；
 * 本地夹具在请求内同步执行 Workflow，响应要等任务结束，所以先从只读库定位，最后再等响应。
 */
export async function submitMedia(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
  label: string,
) {
  const marker = `A red square on a white background. Harden ${runId} ${label}.`
  let response: APIResponse | null | undefined
  const pending = page.request
    .post('/api/ai/tasks', {
      timeout: 180_000,
      data: {
        workspaceId: workspace.workspaceId,
        modelKey: model.key,
        params: { ...model.params, prompt: marker },
      },
    })
    .then(
      (value) => {
        response = value
      },
      () => {
        response = null
      },
    )
  const find = () =>
    query<{ id: string; status: string }>(`select id, status from ai_task
      where workspace_id=${sqlLiteral(workspace.workspaceId)} and user_id=${sqlLiteral(workspace.userId)}
      and model_key=${sqlLiteral(model.key)} and input->'params'->>'prompt'=${sqlLiteral(marker)}`)
  const found = await until(
    async () => {
      if (response === null || (response && response.status() !== 202))
        throw new Error(`${guidancePrefix}媒体提交未被受理（${response?.status() ?? '无响应'}）`)
      const rows = await find()
      must(rows.length <= 1, '同一标记存在重复任务')
      return rows[0]
    },
    60_000,
    200,
  )
  must(found, '提交后 60 秒内未找到任务')
  const settled = async () => {
    await pending
    must(response && response.status() === 202, '媒体提交未返回 202')
    const body = await response.json().catch(() => null)
    must(body?.taskId === found.id, '提交响应的 task ID 与库中任务不一致')
  }
  return { taskId: found.id, initialStatus: found.status, settled }
}

export async function previewCancel(page: Page, workspace: FaultWorkspace, taskId: string) {
  const response = await page.request.get(
    `/api/ai/tasks/${taskId}/cancel?workspaceId=${workspace.workspaceId}`,
    { headers: { 'cache-control': 'no-cache' } },
  )
  must(response.status() === 200, `取消预览返回 ${response.status()}`)
  must(response.headers()['cache-control']?.includes('no-store'), '取消预览未声明 no-store')
  return (await response.json()) as CancelPreview
}

export type CancelExpectation = {
  started: boolean
  charged: boolean
  credits: number
  freeStartedRemaining: number
  cancelBilling: 'free_unstarted' | 'free_started' | 'charged'
}

function previewMatches(preview: CancelPreview, expected: CancelExpectation) {
  return (
    preview.cancelable === true &&
    preview.started === expected.started &&
    preview.charged === expected.charged &&
    preview.credits === expected.credits &&
    preview.freeStartedRemaining === expected.freeStartedRemaining
  )
}

/** 经任务详情页取消：确认弹窗文案须与预览一致，确认后提示与服务端结果一致且没有「状态已变化」。 */
async function cancelThroughUi(
  page: Page,
  workspace: FaultWorkspace,
  taskId: string,
  preview: CancelPreview,
) {
  await page.goto(`/app/${workspace.slug}/tasks/${taskId}`)
  const button = page.getByRole('button', { name: 'Cancel task', exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  const dialog = page.getByRole('alertdialog', { name: 'Cancel this task?', exact: true })
  await expect(dialog).toBeVisible()
  const dialogCopy = !preview.started
    ? copy('media_tasks_cancel_unstarted')
    : !preview.charged
      ? copy('media_tasks_cancel_free_started')
      : copy('media_tasks_cancel_charged', preview.credits)
  const shown = (await dialog.locator('#media-cancel-body').textContent())?.trim()
  must(
    shown === dialogCopy,
    `确认弹窗文案与预览不一致（started=${preview.started}, charged=${preview.charged}）`,
  )
  await dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }).click()
  const notice = preview.charged
    ? copy('media_tasks_cancel_result_charged', preview.credits)
    : copy('media_tasks_cancel_result_refunded')
  await expect(page.getByText(notice, { exact: true })).toBeVisible()
  await expect(page.getByText(copy('media_tasks_cancel_changed'))).toHaveCount(0)
  await expect(page.getByTestId('media-task-status')).toHaveText(copy('media_tasks_canceled'))
  return { dialogCopy: shown, notice }
}

async function cancelThroughApi(page: Page, workspace: FaultWorkspace, taskId: string) {
  const response = await page.request.post(`/api/ai/tasks/${taskId}/cancel`, {
    data: { workspaceId: workspace.workspaceId },
  })
  must([200, 202].includes(response.status()), `取消返回 ${response.status()}`)
  return (await response.json()) as {
    status: string
    cancellationPending: boolean
    cancelBilling: string | null
    creditsCharged: number
  }
}

/** 取消后的数据库核对，并等到任务原期限过后再看一次，确认 Workflow 收尾没有改写取消结算。 */
async function verifyCanceled(
  workspace: FaultWorkspace,
  taskId: string,
  expected: CancelExpectation,
  label: string,
) {
  const read = () => taskSnapshot(workspace, taskId)
  const row = await read()
  must(row.status === 'canceled', `${label} 状态 ${row.status}`)
  must(row.cancelBilling === expected.cancelBilling, `${label} cancel_billing=${row.cancelBilling}`)
  must(row.creditsCharged === expected.credits, `${label} credits_charged=${row.creditsCharged}`)
  checkSettlement(row, expected.credits, label)
  const remaining = await freeStartedRemaining(workspace.workspaceId)
  const deadline = Date.parse(row.deadlineAt)
  const wait = deadline + 15_000 - (await dbNow())
  if (wait > 0) await sleep(wait)
  const after = await read()
  must(
    JSON.stringify(after) === JSON.stringify(row),
    `${label} 期限过后取消结算被改写（${after.status}/${after.cancelBilling}/${after.holdStatus}）`,
  )
  return { row, freeStartedRemaining: remaining, observedAfterDeadlineMs: Math.max(0, wait) }
}

/**
 * 已开始的任务（`workers-timeout`：runner 将任务置为 running 后持久等待到 60 秒期限，不调用 Workers AI）。
 * 同步 Provider 运行中按已开始计（D2），因此不产生真实生成费用。
 */
export async function runStartedCancel(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
  expected: CancelExpectation,
  name: string,
) {
  const submitted = await submitMedia(page, workspace, model, name)
  const running = await until(async () => {
    const row = await taskSnapshot(workspace, submitted.taskId)
    return row.status === 'running' && row.proofInjected ? row : undefined
  }, 40_000)
  must(running, `任务 ${submitted.taskId} 未进入 running`)
  must(running.realProviderCalled === false, '已开始场景调用了真实 Provider')
  must(running.holdStatus === 'held', '运行中的任务预扣不是 held')
  const preview = await previewCancel(page, workspace, submitted.taskId)
  must(
    previewMatches(preview, expected),
    `取消预览 ${JSON.stringify({ ...preview, taskId: undefined })} 与预期不一致`,
  )
  const ui = await cancelThroughUi(page, workspace, submitted.taskId, preview)
  const verified = await verifyCanceled(workspace, submitted.taskId, expected, name)
  await submitted.settled()
  const result = {
    result: 'passed',
    taskId: submitted.taskId,
    modelKey: model.key,
    pricing: model.pricing,
    held: running.held,
    preview: { ...preview, taskId: undefined },
    ui,
    expected,
    after: {
      status: verified.row.status,
      cancelBilling: verified.row.cancelBilling,
      creditsCharged: verified.row.creditsCharged,
      holdStatus: verified.row.holdStatus,
      captured: verified.row.captured,
      releasedCredits: verified.row.held - verified.row.captured,
      ledger: verified.row.ledger,
      realProviderCalled: verified.row.realProviderCalled,
    },
    freeStartedRemainingAfter: verified.freeStartedRemaining,
    observedAfterDeadlineMs: verified.observedAfterDeadlineMs,
    reconciliation: await reconcile(workspace.workspaceId),
  }
  await evidence(name, result)
  return result
}

/**
 * 排队中取消：任务还没被 Workflow 置为 running（无作业 ID、未尝试提交）时取消。
 * 本地夹具延迟 Workflow 启动，走完整 UI 流程；staging 没有可控的排队窗口，提交后立即经 HTTP
 * 预览并取消，预览已显示「已开始」时不取消、等任务按期限失败全退后重试，最多 3 次仍落败则报告无法确认。
 */
export async function runQueuedCancel(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
  name: string,
) {
  const remaining = await freeStartedRemaining(workspace.workspaceId)
  const expected: CancelExpectation = {
    started: false,
    charged: false,
    credits: 0,
    freeStartedRemaining: remaining,
    cancelBilling: 'free_unstarted',
  }
  const lost: Record<string, unknown>[] = []
  for (let attempt = 1; attempt <= (local ? 1 : 3); attempt++) {
    const submitted = await submitMedia(page, workspace, model, `${name}-${attempt}`)
    const preview = await previewCancel(page, workspace, submitted.taskId)
    if (!previewMatches(preview, expected)) {
      // 已被置为 running：不取消（避免消耗免费次数或扣费），等期限失败并核对全额退回。
      must(
        preview.started,
        `排队任务预览不一致 ${JSON.stringify({ ...preview, taskId: undefined })}`,
      )
      const failed = await until(
        async () => {
          const row = await taskSnapshot(workspace, submitted.taskId)
          return ['failed', 'canceled', 'succeeded'].includes(row.status) ? row : undefined
        },
        120_000,
        2_000,
      )
      must(failed?.status === 'failed', `落败任务 ${submitted.taskId} 未按期限失败`)
      checkSettlement(failed, 0, `落败任务 ${submitted.taskId}`)
      await submitted.settled()
      lost.push({ attempt, taskId: submitted.taskId, previewStarted: preview.started })
      continue
    }
    let ui: Record<string, unknown> | undefined
    let api: Awaited<ReturnType<typeof cancelThroughApi>> | undefined
    if (local) ui = await cancelThroughUi(page, workspace, submitted.taskId, preview)
    else api = await cancelThroughApi(page, workspace, submitted.taskId)
    const row = await taskSnapshot(workspace, submitted.taskId)
    if (row.cancelBilling !== 'free_unstarted') {
      // 预览之后、执行之前被 Workflow 抢先置为 running：服务端以执行时为准，记为竞态。
      await submitted.settled()
      await inconclusive(name, '预览为排队中，执行取消时任务已开始（竞态）', {
        taskId: submitted.taskId,
        cancelBilling: row.cancelBilling,
        creditsCharged: row.creditsCharged,
        lost,
      })
    }
    const verified = await verifyCanceled(workspace, submitted.taskId, expected, name)
    await submitted.settled()
    must(verified.freeStartedRemaining === remaining, '排队中取消改变了免费取消次数')
    const result = {
      result: 'passed',
      method: local ? 'local-delayed-workflow-ui' : 'staging-immediate-http',
      attempt,
      lost,
      taskId: submitted.taskId,
      initialStatus: submitted.initialStatus,
      held: row.held,
      preview: { ...preview, taskId: undefined },
      ...(ui ? { ui } : {}),
      ...(api ? { api } : {}),
      expected,
      after: {
        status: verified.row.status,
        cancelBilling: verified.row.cancelBilling,
        creditsCharged: verified.row.creditsCharged,
        holdStatus: verified.row.holdStatus,
        captured: verified.row.captured,
        releasedCredits: verified.row.held - verified.row.captured,
        ledger: verified.row.ledger,
        providerJobId: verified.row.providerJobId,
      },
      freeStartedRemainingAfter: verified.freeStartedRemaining,
      reconciliation: await reconcile(workspace.workspaceId),
    }
    await evidence(name, result)
    return result
  }
  return inconclusive(name, 'staging 上 3 次提交后立即预览均已开始，未能复现排队中取消', { lost })
}

/**
 * 不确定提交（`fal-submit-response-lost`，staging 有 1 次真实 fal 提交）：任务须先进入
 * 「提交确认中」并保持预扣，而不是立即退款；故障策略的等待为 5 秒，之后失败全退并补取消原作业。
 */
export async function runUncertainSubmission(
  page: Page,
  workspace: FaultWorkspace,
  model: FaultModelDefinition,
  name: string,
) {
  const submitted = await submitMedia(page, workspace, model, name)
  const waiting = await until(
    async () => {
      const row = await taskSnapshot(workspace, submitted.taskId)
      if (['failed', 'succeeded', 'canceled'].includes(row.status)) return row
      return row.status === 'running' && row.errorCode === 'MEDIA_SUBMISSION_UNCERTAIN'
        ? row
        : undefined
    },
    60_000,
    250,
  )
  must(waiting, '未观察到提交确认中状态')
  if (waiting.status !== 'running')
    await inconclusive(name, '只读轮询未赶上 5 秒的提交确认窗口', {
      taskId: submitted.taskId,
      status: waiting.status,
    })
  must(
    waiting.holdStatus === 'held' && waiting.providerJobId === null,
    '确认中任务应保留预扣且无作业 ID',
  )
  const terminal = await until(
    async () => {
      const row = await taskSnapshot(workspace, submitted.taskId)
      return ['failed', 'succeeded', 'canceled'].includes(row.status) && row.cancellation
        ? row
        : undefined
    },
    180_000,
    1_000,
  )
  must(terminal, '不确定提交未在 180 秒内结束')
  must(
    terminal.status === 'failed' && terminal.errorCode === 'MEDIA_SUBMISSION_UNCERTAIN',
    `不确定提交终态 ${terminal.status}/${terminal.errorCode}`,
  )
  must(
    terminal.providerJobId === null && terminal.submitAttempts === 1,
    '不确定提交被重试或补入作业 ID',
  )
  checkSettlement(terminal, 0, '不确定提交')
  await submitted.settled()
  const result = {
    result: 'passed',
    taskId: submitted.taskId,
    waiting: {
      status: waiting.status,
      errorCode: waiting.errorCode,
      holdStatus: waiting.holdStatus,
      held: waiting.held,
    },
    terminal: {
      status: terminal.status,
      errorCode: terminal.errorCode,
      holdStatus: terminal.holdStatus,
      captured: terminal.captured,
      submitAttempts: terminal.submitAttempts,
      realProviderCalled: terminal.realProviderCalled,
      externalCancellation: terminal.cancellation,
      ledger: terminal.ledger,
    },
    reconciliation: await reconcile(workspace.workspaceId),
  }
  await evidence(name, result)
  return result
}
