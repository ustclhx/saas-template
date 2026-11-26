import { requireFreshSession, SESSION_REQUIRED } from '@saas/auth'
import { AppError } from '@saas/shared'
import { createFileRoute } from '@tanstack/react-router'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { studioConfigSchema } from '../../../src/config.ts'
import { enabledStudioKinds } from '../../../src/kinds.ts'
import { resolveStudioSite } from '../../../src/site.ts'
import { handleStudioReport } from '../../../src/web/reports-http.ts'
import { invalidateStudioMedia } from '../../../src/web/work-invalidation.ts'

const { reportHideThreshold, sites } = studioConfigSchema.parse(templateConfig.plugins.studio)
const kinds = enabledStudioKinds(templateConfig)

export const Route = createFileRoute('/api/studio/reports')({
  server: {
    handlers: {
      POST: ({ request }) => {
        const runtime = getWebRuntime()
        const site = resolveStudioSite(new URL(request.url).origin, runtime.config.APP_URL, sites)
        return handleStudioReport(request, {
          db: runtime.db,
          site: site?.key ?? null,
          kinds,
          unavailable: pluginUnavailable(runtime, 'studio'),
          hideThreshold: reportHideThreshold,
          invalidate: invalidateStudioMedia,
          clientIp: runtime.requestMeta.clientIp,
          secret: runtime.config.BETTER_AUTH_SECRET,
          turnstileSecret:
            templateConfig.auth.turnstile && runtime.config.TURNSTILE_SITE_KEY
              ? runtime.config.TURNSTILE_SECRET_KEY
              : undefined,
          limit: (key) => runtime.rateLimiter.limit('auth', key),
          async getUserId(headers) {
            try {
              const { user } = await requireFreshSession({
                auth: runtime.auth,
                db: runtime.db,
                headers,
              })
              return user.id
            } catch (error) {
              if (error instanceof AppError && error.code === SESSION_REQUIRED) return null
              throw error
            }
          },
        })
      },
    },
  },
})
