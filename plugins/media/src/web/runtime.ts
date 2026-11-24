import { getAiHttpDeps } from '@web/features/ai/runtime.ts'
import { requireFileStorage } from '@web/features/files/runtime.ts'
import { getWebRuntime } from '@web/server/runtime.ts'

/** 工作流可用不代表已装配 C 的对象存储，提交必须在任务与预扣前检查。 */
export function getFileMediaHttpDeps() {
  requireFileStorage(getWebRuntime())
  return getAiHttpDeps()
}
