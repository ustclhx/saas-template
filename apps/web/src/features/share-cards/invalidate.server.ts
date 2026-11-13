import { requireCapability } from '@saas/platform'
import { AppError } from '@saas/shared'
import { createShareCardInvalidator, type ShareCardIdentity } from '@saas/storage'
import { getWebRuntime } from '../../server/runtime.ts'

/** 项目撤销分享或删除资源时调用；使用当前请求的中立存储与 KV 能力。 */
export async function invalidateShareCard(input: ShareCardIdentity): Promise<void> {
  const runtime = getWebRuntime()
  const files = requireCapability(runtime.files ?? { available: false }, 'files')
  if (!files.shareCards)
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Share card storage is unavailable', {
      status: 503,
    })
  await createShareCardInvalidator(files.shareCards, runtime.cache).invalidateShareCard(input)
}
