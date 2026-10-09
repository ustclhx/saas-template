import type { AiTask } from '@saas/db'
import { AppError } from '@saas/shared'
import { createFalMediaProvider } from './fal.ts'
import { readMediaTaskInput } from './input.ts'
import type { MediaProvider } from './provider.ts'

export interface MediaRuntimeEnv {
  readonly FAL_KEY?: string
  readonly MEDIA_WEBHOOK_SECRET?: string
}

/** 每个任务按提交时的模型快照重建 Provider，查询原始 jobId 不依赖 isolate 内存。 */
export function createTaskMediaProvider(env: MediaRuntimeEnv, task: AiTask): MediaProvider {
  if (task.provider !== 'fal' || !env.FAL_KEY)
    throw new AppError('MEDIA_UNAVAILABLE', 'Media provider is not configured', { status: 503 })
  return createFalMediaProvider({
    apiKey: env.FAL_KEY,
    modelId: readMediaTaskInput(task).providerModelId,
    fetch: globalThis.fetch,
  })
}
