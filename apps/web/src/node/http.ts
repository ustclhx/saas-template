import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeRequestMetadata, withNodeRequestContext } from '@saas/platform/node'
import { log } from '@saas/shared/log'
import { useNitroApp as getNitroApp, useNitroHooks as getNitroHooks } from 'nitro/app'
import type { ServerRequest } from 'srvx'
import { serve } from 'srvx/node'
import { attachWebRuntime } from './request-runtime.ts'
import { createNodeWebProcess, prerenderRuntime } from './runtime.ts'

const nitroApp = getNitroApp()
const previewMetadata = createNodeRequestMetadata([])
let resources: Awaited<ReturnType<typeof createNodeWebProcess>> | undefined
let stopping = false

/** Nitro preview 导入同一 fetch，但不会执行下面的生产 listen 分支。 */
export async function fetch(request: ServerRequest): Promise<Response> {
  if (stopping) return new Response('Service Unavailable', { status: 503 })
  const meta = (resources?.metadata ?? previewMetadata)(
    request,
    request.runtime?.node?.req.socket.remoteAddress,
  )
  const release = resources?.background.beginRequest()
  let handlerDone = false
  let outputDone = !request.runtime?.node?.res
  const finished = () => {
    outputDone = true
    if (handlerDone) release?.()
  }
  request.runtime?.node?.res?.once('finish', finished)
  request.runtime?.node?.res?.once('close', finished)
  try {
    return await withNodeRequestContext(meta, async () => {
      if (new URL(request.url).pathname === '/internal/live')
        return Response.json(
          { status: 'ok', version: __APP_VERSION__ },
          { headers: { 'cache-control': 'no-store' } },
        )
      attachWebRuntime(request, resources?.requestRuntime(meta) ?? prerenderRuntime(meta))
      return nitroApp.fetch(request)
    })
  } finally {
    handlerDone = true
    if (outputDone) release?.()
  }
}

// 直接执行产物才启动生产资源；构建期 preview 的 import 不允许触发 dotenv、池或 signal 副作用。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.NITRO_PORT ?? process.env.PORT ?? 3000)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')
    resources = await createNodeWebProcess()
    const processResources = resources
    const server = serve({
      port,
      hostname: process.env.NITRO_HOST ?? process.env.HOST ?? '0.0.0.0',
      fetch,
      gracefulShutdown: false,
      manual: true,
      silent: true,
    })
    await server.serve()
    log.info('node.web.started')
    const http = server.node?.server
    let shutdown: Promise<void> | undefined
    const stop = () => {
      if (shutdown) return
      shutdown = (async () => {
        const result = await processResources.background.shutdown({
          timeoutMs: processResources.env.SHUTDOWN_TIMEOUT_MS,
          stopReceiving: () => {
            stopping = true
            http?.close()
            if (http && 'closeIdleConnections' in http) http.closeIdleConnections()
          },
          closeResources: async () => {
            await processResources.close()
            await getNitroHooks().callHook('close')
          },
        })
        if (http && 'closeAllConnections' in http) http.closeAllConnections()
        log.info('node.web.stopped', { ...result })
        process.exit(result.completed && result.resourcesClosed ? 0 : 1)
      })()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
  } catch (error) {
    // 启动错误仅允许配置校验的字段名；驱动、路径或连接串不能出现在日志。
    const { EnvValidationError } = await import('@saas/config')
    log.error(
      'node.web.start_failed',
      error instanceof EnvValidationError ? { fields: [...error.missing, ...error.invalid] } : {},
    )
    await resources?.close()
    process.exit(1)
  }
}
