import { env } from 'cloudflare:workers'
import { createFalMediaProvider, readMediaTaskInput, type TaskMediaProvider } from '@saas/ai'
import type { AiTask } from '@saas/db'
import type { JsonValue, Workflow, WorkflowInstance, WorkflowStep } from '@saas/platform'
import { AppError } from '@saas/shared'
import { persistMediaOutputs } from '@saas/storage'
import { createCloudflareMediaCopier } from '@saas/storage/cloudflare'
import { runMediaTask } from '../../../../plugins/media/src/jobs/media-runner.ts'
import {
  handleMediaWebhook,
  type MediaHttpDeps,
} from '../../../../plugins/media/src/web/media-tasks.ts'
import type { WebAiRuntime } from '../../src/server/runtime.ts'
import { faultEnv } from './fault-local-runtime.ts'

const secret = 'fault-local-only-fixture'
const bytes = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPZkAAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
)
const imageUrl = 'https://v3.fal.media/files/local-fault.png'
const result = { images: [{ url: imageUrl, content_type: 'image/png', width: 1, height: 1 }] }
let keys: Promise<CryptoKeyPair> | undefined
const localKeys = () => {
  // workerd 不允许模块顶层执行异步 IO，密钥只在本地回调请求中生成。
  keys ??= crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as Promise<CryptoKeyPair>
  return keys
}
const base64url = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function signedCallback(url: string, jobId: string, deps: MediaHttpDeps) {
  const body = JSON.stringify({ request_id: jobId, status: 'OK', payload: result })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const user = 'local-fault-user'
  const encoder = new TextEncoder()
  const hash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)))
  const signature = hex(
    await crypto.subtle.sign(
      'Ed25519',
      (await localKeys()).privateKey,
      encoder.encode([jobId, user, timestamp, hash].join('\n')),
    ),
  )
  const request = new Request(url, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-fal-webhook-request-id': jobId,
      'x-fal-webhook-user-id': user,
      'x-fal-webhook-timestamp': timestamp,
      'x-fal-webhook-signature': signature,
    },
  })
  const response = await handleMediaWebhook(request, 'fal', deps)
  if (!response.ok) throw new Error('Local signed webhook was rejected')
}

// 原 Provider 仍执行提交、状态解析、取消与验签；夹具只替换网络传输，模式由生产 wrapper 注入。
function localProvider(task: AiTask, deps: MediaHttpDeps): TaskMediaProvider {
  const input = readMediaTaskInput(task)
  if (task.provider === 'workers-ai')
    return {
      id: 'workers-ai',
      capabilities: { synchronous: true, idempotentSubmit: true },
      async run() {
        return {
          outputs: [{ body: bytes, mime: 'image/png', width: 1, height: 1 }],
          usage: { images: 1 },
        }
      },
    }
  if (task.provider !== 'fal' || input.providerModelId !== 'fal-ai/flux/schnell')
    throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Unknown local media provider')
  const jobId = `local_${task.id.replaceAll('-', '_')}`
  const fakeFetch: typeof fetch = async (request, init) => {
    const url = new URL(
      typeof request === 'string' ? request : request instanceof URL ? request : request.url,
    )
    const method = init?.method ?? 'GET'
    if (url.toString() === 'https://rest.fal.ai/.well-known/jwks.json')
      return Response.json({
        keys: [
          { x: base64url(await crypto.subtle.exportKey('raw', (await localKeys()).publicKey)) },
        ],
      })
    if (url.origin !== 'https://queue.fal.run')
      throw new Error('External local fixture request rejected')
    if (method === 'POST' && url.pathname === '/fal-ai/flux/schnell') {
      const callback = url.searchParams.get('fal_webhook')
      if (callback) await signedCallback(callback, jobId, deps)
      return Response.json({ request_id: jobId })
    }
    const path = `/fal-ai/flux/requests/${jobId}`
    if (method === 'GET' && url.pathname === `${path}/status`)
      return Response.json({ request_id: jobId, status: 'COMPLETED' })
    if (method === 'GET' && url.pathname === path) return Response.json(result)
    if (method === 'PUT' && url.pathname === `${path}/cancel`)
      return new Response(null, { status: 202 })
    throw new Error('Unknown local fal request rejected')
  }
  return createFalMediaProvider({
    apiKey: 'local-fake',
    modelId: input.providerModelId,
    fetch: fakeFetch,
  })
}

function localWorkflow(deps: MediaHttpDeps): Workflow<{ taskId: string }> {
  const instance = (id: string): WorkflowInstance => ({
    id,
    status: async () => ({ status: 'completed' }),
    terminate: async () => {},
    sendEvent: async () => {},
  })
  return {
    get: async (id) => instance(id),
    async create({ params }) {
      // 仅 harden-ai 本地入口设置：模拟 Workflow 调度延迟，任务在此期间保持 queued，供「排队中取消」复现；
      // 默认 0，其他本地入口行为不变。
      const delay =
        Number((env as { LOCAL_WORKFLOW_START_DELAY_MS?: string }).LOCAL_WORKFLOW_START_DELAY_MS) ||
        0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const step: WorkflowStep = {
        do: async <T extends JsonValue>(
          _name: string,
          options: unknown,
          callback?: () => Promise<T>,
        ): Promise<T> => {
          const action = typeof options === 'function' ? (options as () => Promise<T>) : callback
          if (!action) throw new Error('Missing local step callback')
          return action()
        },
        sleep: async (_name, ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms))
        },
        waitForEvent: async (_name, options) => {
          await new Promise((resolve) => setTimeout(resolve, options.timeoutMs))
          throw new Error('Local workflow event timeout')
        },
      }
      await runMediaTask(params.taskId, step, {
        db: deps.db,
        provider: (task) => localProvider(task, deps),
        params: async (task) => readMediaTaskInput(task).params,
        callbackOrigin: deps.env.APP_URL ?? 'http://localhost',
        callbackSecret: secret,
        faultEnv,
        persist: (task, output) =>
          persistMediaOutputs({
            db: deps.db,
            storage: env.FILES,
            copyOutput: createCloudflareMediaCopier(env.FILES, {
              fetch: async (request) => {
                const url =
                  typeof request === 'string'
                    ? request
                    : request instanceof URL
                      ? request.toString()
                      : request.url
                if (url !== imageUrl) throw new Error('External local image request rejected')
                return new Response(bytes, {
                  headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) },
                })
              },
            }),
            task,
            result: output,
            limits: {
              maxFileBytes: 1024,
              storageBytes: 1024 ** 3,
              allowedMimeTypes: ['image/png'],
              allowedHosts: ['v3.fal.media'],
            },
          }),
      })
      return instance(params.taskId)
    },
  }
}

export function localHttpDeps<T extends MediaHttpDeps>(real: T): T {
  const deps = {
    ...real,
    env: { ...real.env, ...faultEnv, MEDIA_WEBHOOK_SECRET: secret, FAL_KEY: 'local-fake' },
    providerFactory: (_env: unknown, task: AiTask) => localProvider(task, deps),
  }
  return { ...deps, workflow: { available: true, value: localWorkflow(deps) } }
}

export function localMediaAi(ai: WebAiRuntime): WebAiRuntime {
  return {
    ...ai,
    config: {
      ...ai.config,
      FAL_KEY: 'local-fake',
      MEDIA_WEBHOOK_SECRET: secret,
    },
    workersAi: { available: true, value: { run: async () => bytes } },
  }
}
