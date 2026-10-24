import { isDeepStrictEqual } from 'node:util'
import { FAULT_MODELS, type FaultModelDefinition } from './fault-definitions.ts'
import { withFaultModels } from './fault-models.ts'
import { prepareFaultReadiness } from './fault-readiness.ts'
import {
  type CancelExpectation,
  DEFAULT_FREE_FAILURES,
  type FreeFailurePolicy,
  freeStartedRemaining,
  Inconclusive,
  readFreeFailurePolicy,
  runFreeFailureGroup,
  runQueuedCancel,
  runStartedCancel,
  runUncertainSubmission,
  saveFreeFailurePolicy,
  settingAudits,
  waitFreeFailuresExpire,
} from './harden-ai-support.ts'
import { evidence, local, test } from './support.ts'

const fault = (mode: string, pricing?: string) => {
  const model = FAULT_MODELS.find(
    (item) => item.mode === mode && (!pricing || item.pricing.mode === pricing),
  )
  if (!model) throw new Error(`Missing fault model ${mode} ${pricing ?? ''}`)
  return model
}

// 第二组需要窗口滚动：临时把窗口缩到 5 分钟（次数仍为 3），用例结束时经后台设置页恢复原值。
const SHORT_WINDOW: FreeFailurePolicy = { count: 3, windowSeconds: 300 }

test('harden-ai-text：同一空间窗口内前 3 次无正文失败全退、第 4 次按最后一次尝试结算 @harden-ai-text', async ({
  page,
}) => {
  test.setTimeout(40 * 60_000)
  const perCall = fault('chat-before-stream', 'per_call')
  const token = fault('chat-before-stream', 'token')
  const workspace = await prepareFaultReadiness(page)
  const startedAt = Date.now() - 60_000
  const original = await readFreeFailurePolicy()
  const applied: FreeFailurePolicy[] = []
  const apply = async (value: FreeFailurePolicy) => {
    if (isDeepStrictEqual((await readFreeFailurePolicy()).value, value)) return
    await saveFreeFailurePolicy(page, value)
    applied.push(value)
  }
  let failure: unknown
  try {
    await withFaultModels(page, [perCall, token], async () => {
      // 第一组使用默认设置（3 次 / 60 分钟），即规格中的「1 小时内第 4 次」。
      await apply(DEFAULT_FREE_FAILURES)
      await test.step('per_call：默认 3 次 / 1 小时', () =>
        runFreeFailureGroup(
          page,
          workspace,
          perCall,
          DEFAULT_FREE_FAILURES,
          'harden-ai-text-per_call',
        ))
      // 第一组的 3 次免费失败仍在 1 小时窗口内；缩短窗口并等它们滚出，同时验证「窗口滚动后恢复免费」。
      await apply(SHORT_WINDOW)
      const expired = await waitFreeFailuresExpire(
        workspace.workspaceId,
        SHORT_WINDOW.windowSeconds,
        (SHORT_WINDOW.windowSeconds + 60) * 1000,
      )
      if (!expired) throw new Error('第一组免费失败未在缩短的窗口后滚出')
      await test.step('token：窗口滚动后重新计数', () =>
        runFreeFailureGroup(page, workspace, token, SHORT_WINDOW, 'harden-ai-text-token'))
    })
  } catch (error) {
    failure = error
  }
  // 无论成败都恢复设置并记录；catch 已接住原错误，这里不再需要 finally。
  {
    let restoreError: unknown
    if (applied.length) {
      try {
        await saveFreeFailurePolicy(page, original.value)
      } catch (error) {
        restoreError = error
      }
    }
    const restored = await readFreeFailurePolicy()
    await evidence('harden-ai-text-settings', {
      failedReplyRefundSwitch: 'template.config ai.text.failedReplyRefund（逐条核对检查点记录值）',
      original,
      applied,
      restored,
      restoredMatches: isDeepStrictEqual(restored.value, original.value),
      auditIds: (await settingAudits(startedAt)).map((audit) => audit.id),
    })
    if (restoreError || !isDeepStrictEqual(restored.value, original.value))
      throw new AggregateError(
        [failure, restoreError].filter(Boolean),
        `ai.freeFailures 未能恢复为 ${JSON.stringify(original.value)}，请到 /admin/settings 手动恢复`,
      )
  }
  if (failure) throw failure
})

test('harden-ai-media：已开始任务首次取消免费、再次取消全价、排队中取消免费 @harden-ai-media', async ({
  page,
}) => {
  test.setTimeout(30 * 60_000)
  const stalled = fault('workers-timeout')
  if (stalled.pricing.mode !== 'per_call') throw new Error('Unexpected stalled pricing')
  const fullPrice = stalled.pricing.credits
  const workspace = await prepareFaultReadiness(page)
  const pending: string[] = []
  await withFaultModels(page, [stalled], async () => {
    const remaining = await freeStartedRemaining(workspace.workspaceId)
    if (remaining === 1) {
      const first: CancelExpectation = {
        started: true,
        charged: false,
        credits: 0,
        freeStartedRemaining: 1,
        cancelBilling: 'free_started',
      }
      await test.step('已开始任务首次取消：免费', () =>
        runStartedCancel(page, workspace, stalled, first, 'harden-ai-media-started-first'))
    } else {
      // 终身一次的免费取消已在该空间用过（如重跑），首次免费无法在此空间再验证。
      pending.push('started-first')
      await evidence('harden-ai-media-started-first', {
        result: 'inconclusive',
        reason: `空间 ${workspace.workspaceId} 已用过终身免费取消`,
      })
    }
    const second: CancelExpectation = {
      started: true,
      charged: true,
      credits: fullPrice,
      freeStartedRemaining: 0,
      cancelBilling: 'charged',
    }
    await test.step('已开始任务再次取消：按定价快照全价', () =>
      runStartedCancel(page, workspace, stalled, second, 'harden-ai-media-started-second'))
    await test.step('排队中取消：免费且不占免费次数', async () => {
      try {
        await runQueuedCancel(page, workspace, stalled, 'harden-ai-media-queued')
      } catch (error) {
        if (!(error instanceof Inconclusive)) throw error
        pending.push('queued')
      }
    })
  })
  if (pending.length) throw new Inconclusive(`[无法确认] 未得出结论的子项：${pending.join(', ')}`)
})

test('harden-ai-media：不确定提交保留预扣并进入提交确认中 @harden-ai-media', async ({ page }) => {
  // staging 上这是一次真实 fal 图片提交（约 1 张 512² flux/schnell），默认不跑，需显式开启。
  test.skip(
    !local && process.env.STAGING_HARDEN_AI_UNCERTAIN !== '1',
    'Set STAGING_HARDEN_AI_UNCERTAIN=1 to run the optional uncertain submission (one real fal call)',
  )
  test.setTimeout(15 * 60_000)
  const lost: FaultModelDefinition = fault('fal-submit-response-lost')
  const workspace = await prepareFaultReadiness(page)
  await withFaultModels(page, [lost], () =>
    runUncertainSubmission(page, workspace, lost, 'harden-ai-media-uncertain'),
  )
})
