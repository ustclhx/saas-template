export const MEDIA_MAX_FILE_BYTES = 100 * 1024 * 1024
export const MEDIA_OUTPUT_MIME_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm'],
} as const

import type { TemplateConfig } from './template.ts'

export const MEDIA_PROVIDER_IDS = ['fal', 'workers-ai'] as const
export type MediaProviderId = (typeof MEDIA_PROVIDER_IDS)[number]
export type MediaPluginConfig = { readonly providers?: readonly MediaProviderId[] }

/** 未启用插件时无媒体服务商；启用且省略配置时沿用模板默认列表。 */
export function getMediaProviders(
  config: Pick<TemplateConfig, 'plugins'>,
): readonly MediaProviderId[] {
  return config.plugins.media ? (config.plugins.media.providers ?? MEDIA_PROVIDER_IDS) : []
}
