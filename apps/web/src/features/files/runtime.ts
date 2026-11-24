import { requireCapability } from '@saas/platform'
import type { WebRuntime } from '../../server/runtime.ts'

export function requireFileStorage(runtime: Pick<WebRuntime, 'files'>) {
  return requireCapability(runtime.files ?? { available: false }, 'files')
}
