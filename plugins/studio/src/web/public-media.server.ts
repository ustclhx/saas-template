import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { enabledStudioKinds } from '../kinds.ts'
import { resolveStudioSite, type StudioSiteOrigins, studioSiteOrigin } from '../site.ts'
import type { MediaOptions } from './public-media.ts'
import { getPublicWorkMedia } from './public-works.ts'

const studio = templateConfig.plugins.studio as { sites?: StudioSiteOrigins } | undefined

export function studioOriginForSite(site: string): string | undefined {
  return studioSiteOrigin(site, getWebRuntime().config.APP_URL, studio?.sites)
}

export function studioMediaOptions(url: URL, filesAvailable = true): MediaOptions {
  const runtime = getWebRuntime()
  const options = {
    site: resolveStudioSite(url.origin, runtime.config.APP_URL, studio?.sites),
    kinds: enabledStudioKinds(templateConfig),
  }
  if (
    !filesAvailable ||
    pluginUnavailable(runtime, 'studio') ||
    pluginUnavailable(runtime, 'media')
  )
    return options
  const files = runtime.files
  if (!files?.available || !files.value.read) return options
  return {
    ...options,
    findMedia: (input) => getPublicWorkMedia(runtime.db, input),
    read: files.value.read,
  }
}
