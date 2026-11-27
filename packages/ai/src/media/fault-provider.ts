import { AppError } from '@saas/shared'
import { FalProviderError } from './fal.ts'
import type { MediaAcceptanceFault, MediaAcceptanceFaultProof } from './fault.ts'
import { isSyncMediaProvider, type TaskMediaProvider } from './provider.ts'

export interface MediaFaultProviderDeps {
  proof(patch: Partial<MediaAcceptanceFaultProof>): Promise<void>
  now?: () => number
}

/** 只包装已校验的单任务快照；原 Provider 仍负责真实提交、查询与验签。 */
export function wrapMediaFaultProvider(
  provider: TaskMediaProvider,
  fault: MediaAcceptanceFault,
  deps: MediaFaultProviderDeps,
): TaskMediaProvider {
  const injected = () => ({
    injected: true,
    injectedAt: new Date((deps.now ?? Date.now)()).toISOString(),
  })
  if (isSyncMediaProvider(provider)) {
    return {
      id: provider.id,
      capabilities: provider.capabilities,
      async run() {
        // stalled 的持久等待由 runner 执行，不能在这里返回模拟图片。
        if (fault.mode !== 'workers-error')
          throw new AppError('ACCEPTANCE_FAULT_INVALID', 'Invalid synchronous fault execution')
        await deps.proof({ ...injected(), realProviderCalled: false })
        throw new AppError(
          'WORKERS_AI_GENERATION_FAILED',
          'Injected Workers AI inference failure',
          {
            details: { retryable: false },
          },
        )
      },
    }
  }
  const cancel = provider.cancel?.bind(provider)
  return {
    id: provider.id,
    capabilities: provider.capabilities,
    async submit(input) {
      if (fault.mode === 'fal-rate-limited') {
        // 不调用真实服务商：模拟 fal 明确拒绝的 429，runner 据此切到备用模型。
        await deps.proof({ ...injected(), realProviderCalled: false })
        throw new FalProviderError(
          'FAL_RATE_LIMITED',
          'Injected fal.ai rate limit',
          429,
          'rejected',
        )
      }
      await deps.proof({ realProviderCalled: true })
      const { webhookUrl: _webhookUrl, ...withoutWebhook } = input
      const result = await provider.submit(
        // 切换验收保留回调地址：真实作业的晚到回调属于旧尝试，用于验证它被忽略。
        fault.mode === 'fal-callback-early' || fault.mode === 'fal-failover-job-failed'
          ? input
          : withoutWebhook,
      )
      await deps.proof({ realRequestId: result.jobId })
      if (fault.mode === 'fal-submit-response-lost') {
        await deps.proof(injected())
        throw new FalProviderError(
          'FAL_NETWORK_ERROR',
          'Injected fal.ai submission response loss',
          undefined,
          'ambiguous',
        )
      }
      if (fault.mode === 'fal-callback-lost') await deps.proof(injected())
      // 专用异步场景只接受原 request ID，不能通过 sync 快捷结果绕过轮询/屏障。
      return { jobId: result.jobId }
    },
    async getStatus(jobId) {
      const status = await provider.getStatus(jobId)
      if (fault.mode === 'fal-provider-error') {
        await deps.proof(injected())
        return {
          status: 'failed',
          error: { code: 'FAL_GENERATION_FAILED', message: 'Injected fal.ai generation failure' },
        }
      }
      if (fault.mode === 'fal-failover-job-failed') {
        // 真实作业照常生成，它晚到的成功回调用于验证旧尝试的回调被忽略。
        await deps.proof(injected())
        return {
          status: 'failed',
          error: {
            code: 'FAL_GENERATION_FAILED',
            message: 'Injected fal.ai provider-side failure',
            kind: 'provider_error',
          },
        }
      }
      if (fault.mode === 'fal-timeout') {
        await deps.proof(injected())
        return { status: 'queued' }
      }
      return status
    },
    parseWebhook: (request, rawBody) => provider.parseWebhook(request, rawBody),
    ...(cancel ? { cancel } : {}),
  }
}
