import { env as workerEnv } from 'cloudflare:workers'
import type { WorkerPluginModule } from '@web/server/cloudflare/plugins.ts'
import { studioMediaOptions, studioOriginForSite } from '../web/public-media.server.ts'
import { handleStudioMedia } from '../web/public-media.ts'
import { createStudioWorkInvalidator, setStudioMediaInvalidator } from '../web/work-invalidation.ts'
import { registerStudioDeletionSteps } from '../web/works-delete-cleanup.ts'
import { deleteStudioWorkPageCache, studioPublicPagesFetch } from './page-cache.ts'

const edgeCache = () => (caches as unknown as { default: Cache }).default
const { CF_PURGE_TOKEN, CF_ZONE_ID } = workerEnv as {
  CF_PURGE_TOKEN?: string
  CF_ZONE_ID?: string
}

const invalidateMedia = createStudioWorkInvalidator({
  originForSite: studioOriginForSite,
  cache: { delete: (url) => edgeCache().delete(url) },
  purge: { token: CF_PURGE_TOKEN, zoneId: CF_ZONE_ID },
})
// 媒体地址之外同时删除本机房的作品页副本（画廊页面缓存，page-cache.ts）
const invalidate: typeof invalidateMedia = async (work) => {
  await Promise.all([invalidateMedia(work), deleteStudioWorkPageCache(edgeCache(), work)])
}
setStudioMediaInvalidator(invalidate)
registerStudioDeletionSteps(invalidate)

export default {
  async fetch(request, env, ctx) {
    const page = await studioPublicPagesFetch(request, edgeCache(), ctx)
    if (page) return page
    return handleStudioMedia(request, (url) => ({
      ...studioMediaOptions(url, typeof env.FILES?.get === 'function'),
      edge: {
        cache: edgeCache(),
        waitUntil: (promise) => ctx.waitUntil(promise),
        fixedLength(body, size) {
          // Workers 忽略普通流的 Content-Length；定长流让 Cache API 命中时可切出 Range。
          const { readable, writable } = new FixedLengthStream(size)
          ctx.waitUntil(body.pipeTo(writable).catch(() => {}))
          return readable
        },
      },
    }))
  },
} satisfies WorkerPluginModule
