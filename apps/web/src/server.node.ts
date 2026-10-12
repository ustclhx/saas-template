import { AppError } from '@saas/shared'
import { log, withLogContext } from '@saas/shared/log'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { gateAdminRequest } from './features/admin/gate.ts'
import {
  gatePublicApiRequest,
  isPublicApiPath,
  normalizePublicApiNotFound,
} from './features/api-keys/gate.ts'
import { gateLocaleRequest } from './features/i18n/gate.ts'
import { localizeRequest } from './features/i18n/request.server.ts'
import { requestWebRuntime } from './node/request-runtime.ts'
import { withWebRuntime } from './server/runtime.ts'
import { SENTRY_TEST_PATH, sentryTest } from './server/sentry-test.ts'
import { templateConfig } from './server/template-config.ts'

const startHandler = createStartHandler(defaultStreamHandler)

export default {
  fetch(request: Request): Promise<Response> {
    const runtime = requestWebRuntime(request)
    return withLogContext(
      { requestId: runtime.requestMeta.requestId, cfRay: runtime.requestMeta.cfRay },
      () =>
        withWebRuntime(runtime, async () => {
          const started = Date.now()
          const path = new URL(request.url).pathname
          try {
            if (path === SENTRY_TEST_PATH) return await sentryTest(request, runtime)
            const gated = gatePublicApiRequest(request, templateConfig)
            const localized = gateLocaleRequest(await gateAdminRequest(request, runtime))
            const response =
              gated ?? (await localizeRequest(localized, runtime, () => startHandler(localized)))
            const result = isPublicApiPath(path)
              ? await normalizePublicApiNotFound(response)
              : response
            log.info('http.request', {
              method: request.method,
              path,
              status: result.status,
              durationMs: Date.now() - started,
            })
            return result
          } catch (error) {
            log.error('http.unhandled', { error })
            return error instanceof AppError
              ? Response.json(error.toJSON(), { status: error.status })
              : new Response('Internal Server Error', { status: 500 })
          }
        }),
    )
  },
}
