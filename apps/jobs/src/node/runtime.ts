import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import type { NodeEnv } from '@saas/config/node'
import { createDb } from '@saas/db'
import {
  createNodeBackgroundTasks,
  createNodeCache,
  unavailableTaskCapabilities,
} from '@saas/platform/node'
import { log, newRequestId, withLogContext } from '@saas/shared/log'

/** B 装配前不启动消费者/调度器；探活只证明进程存活，不冒充依赖 readiness。 */
export async function startNodeJobs(config: NodeEnv, options: { host: string; port: number }) {
  const background = createNodeBackgroundTasks()
  const tasks = unavailableTaskCapabilities()
  const db = createDb(config.DATABASE_URL, { max: config.DB_POOL_MAX })
  let cache: Awaited<ReturnType<typeof createNodeCache>>
  try {
    cache = await createNodeCache({ url: config.VALKEY_URL, namespace: config.CACHE_NAMESPACE })
  } catch (error) {
    await db.close()
    throw error
  }
  const sockets = new Set<Socket>()
  let stopping = false
  const server = createServer((request, response) => {
    const release = background.beginRequest()
    response.once('finish', release)
    response.once('close', release)
    withLogContext({ requestId: newRequestId() }, () => {
      response.setHeader('cache-control', 'no-store')
      if (stopping) {
        response.writeHead(503).end()
      } else if (request.method === 'GET' && request.url === '/internal/live') {
        background.waitUntil(
          Promise.all([tasks.health.queue(), tasks.health.scheduler()]).then(
            ([queue, scheduler]) => {
              response.setHeader('content-type', 'application/json')
              response.end(JSON.stringify({ status: 'ok', queue, scheduler }))
            },
          ),
        )
      } else {
        response.writeHead(404).end()
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  async function closeResources() {
    // 同时发起驱动关闭；共享 deadline 覆盖 drain 与资源释放。
    await Promise.all([cache.close(), db.close()])
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await closeResources()
    throw error
  }
  let shutdown: ReturnType<typeof background.shutdown> | undefined
  return {
    server,
    background,
    db,
    cache,
    tasks,
    shutdown() {
      shutdown ??= background
        .shutdown({
          timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
          stopReceiving() {
            stopping = true
            server.close()
          },
          closeResources,
        })
        .then((result) => {
          // server.close 不等待未完成/半开 socket；deadline 到达后不让其持有进程。
          for (const socket of sockets) socket.destroy()
          log.info('jobs.node.stopped', { ...result })
          return result
        })
      return shutdown
    },
  }
}
