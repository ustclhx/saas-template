import type { AiModality } from '@saas/config'
import { AppError } from '@saas/shared'

/** 保存端复核模板启用列表，避免绕过表单登记未启用的媒体服务商。 */
export function assertModelProviderEnabled(
  kind: AiModality,
  provider: string,
  mediaProviders: readonly string[],
): void {
  if (kind !== 'text' && !mediaProviders.includes(provider)) {
    throw new AppError('MEDIA_PROVIDER_DISABLED', 'Media provider is not enabled', { status: 400 })
  }
}
