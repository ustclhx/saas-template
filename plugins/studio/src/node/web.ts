import type { WebNodePluginModule } from '@web/node/plugins.ts'
import { studioMediaOptions, studioOriginForSite } from '../web/public-media.server.ts'
import { handleStudioMedia } from '../web/public-media.ts'
import { createStudioWorkInvalidator, setStudioMediaInvalidator } from '../web/work-invalidation.ts'
import { registerStudioDeletionSteps } from '../web/works-delete-cleanup.ts'

const invalidate = createStudioWorkInvalidator({
  originForSite: studioOriginForSite,
  purge: { token: process.env.CF_PURGE_TOKEN, zoneId: process.env.CF_ZONE_ID },
})
setStudioMediaInvalidator(invalidate)
registerStudioDeletionSteps(invalidate)

export default {
  fetch: (request) => handleStudioMedia(request, studioMediaOptions),
} satisfies WebNodePluginModule
