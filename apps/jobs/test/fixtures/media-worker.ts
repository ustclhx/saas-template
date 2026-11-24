import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { defineTemplateConfig } from '@saas/config'
import type { NodeStorageConfig } from '@saas/config/node'
import { createDb } from '@saas/db'
import { createNodeJobEngine } from '@saas/platform/node'
import { logJobObserver } from '@saas/shared/log'
import mediaJobs from '../../../../plugins/media/src/node/jobs.ts'

interface Config {
  executorId: string
  ownershipDirectory: string
  storage: NodeStorageConfig
  secret: string
  crashAfter?: 'persist' | 'settle-and-notify'
}
const config: Config = JSON.parse(process.env.TEST_MEDIA_WORKER_CONFIG ?? '{}')
const databaseUrl = process.env.TEST_JOB_DATABASE_URL
if (!databaseUrl) throw new Error('Node media worker requires isolated PG')
const db = createDb(databaseUrl, { max: 3 })
const emit = (value: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    process.send?.(value, (error) =>
      error ? reject(new Error('Media fixture IPC failed')) : resolve(),
    )
  })

// 所有 Provider fetch 都在此拒绝或响应；真实 S3 SDK 使用自己的 HTTP transport。
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === 'https://queue.fal.run' && init?.method === 'POST') {
    await emit({ event: 'submit' })
    return Response.json({ request_id: 'fixture-job' })
  }
  if (url.origin === 'https://queue.fal.run' && init?.method === 'PUT') {
    await emit({ event: 'cancel' })
    return Response.json({ status: 'CANCELLATION_REQUESTED' })
  }
  if (url.href === 'https://fal.media/b-media-fixture.png') {
    await emit({ event: 'download' })
    return new Response('png', {
      headers: { 'content-type': 'image/png', 'content-length': '3' },
    })
  }
  throw new Error('Unexpected media fixture outbound request')
}

// 在正式 step callback 已返回、DBOS 尚未记录结果时退出，保持生产步骤/重试策略不变。
const runStep = DBOS.runStep.bind(DBOS)
DBOS.runStep = async <T>(
  callback: () => Promise<T>,
  options?: Parameters<typeof DBOS.runStep>[1],
): Promise<T> =>
  runStep(async () => {
    const value = await callback()
    if (
      config.crashAfter &&
      options?.name === `workflow.do:${JSON.stringify([config.crashAfter, 0])}`
    ) {
      await emit({ event: 'before-checkpoint', step: config.crashAfter })
      process.kill(process.pid, 'SIGKILL')
      await new Promise(() => {})
    }
    return value
  }, options)

const template = defineTemplateConfig({
  app: {
    name: 'Media fixture',
    url: 'https://app.example.test',
    supportEmail: 'support@app.example.test',
  },
  ai: { image: true },
  plugins: { media: { providers: ['fal'] } },
})
let workflows: ReturnType<typeof mediaJobs.registerWorkflows> | undefined
const engine = await createNodeJobEngine({
  database: db,
  databaseUrl,
  executorId: config.executorId,
  applicationVersion: 'b-media-recovery-v1',
  ownershipDirectory: config.ownershipDirectory,
  nativePoolMax: 3,
  shutdownTimeoutMs: 100,
  register(engine) {
    workflows = mediaJobs.registerWorkflows({
      engine,
      config: {
        APP_URL: template.app.url,
        FAL_KEY: 'local-fixture',
        MEDIA_WEBHOOK_SECRET: config.secret,
      },
      template,
      storage: config.storage,
      observer: logJobObserver,
    })
  },
  stopReceiving() {
    workflows?.stopReceiving()
  },
})
const handler = workflows?.http['/internal/workflows/ai-media']
if (!handler) throw new Error('Node media fixture workflow was not registered')
const server = createServer((request, response) => {
  void handler(request, response)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
process.once('SIGTERM', () => {
  server.closeAllConnections()
  server.close()
  void engine
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
})
await emit({ event: 'ready', port: (server.address() as AddressInfo).port })
