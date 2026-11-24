import type { WebAiRuntime, WebRuntime } from '../../src/server/runtime.ts'

export const faultEnv = { SENTRY_ENVIRONMENT: 'staging', AI_FAULT_INJECTION: 'enabled' } as const
const externalKeys = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'SENTRY_DSN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'AI_GATEWAY_TOKEN',
  'AI_GATEWAY_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'FAL_KEY',
  'MEDIA_WEBHOOK_SECRET',
  'RESEND_API_KEY',
]

export function localBindings<T extends object>(bindings: T): T {
  return { ...bindings, ...Object.fromEntries(externalKeys.map((key) => [key, ''])), ...faultEnv }
}

// getter 保留请求原有 DB、auth、R2 和 cache；健康检查只报告本地夹具，不访问 jobs。
export function localWebRuntime(
  runtime: WebRuntime,
  withMedia?: (ai: WebAiRuntime) => WebAiRuntime,
): WebRuntime {
  if (!runtime.ai?.available) throw new Error('Local fault runtime requires AI composition')
  const ai: WebAiRuntime = {
    ...runtime.ai.value,
    config: {
      ...faultEnv,
      AI_TEXT_EGRESS: 'direct',
      DEEPSEEK_API_KEY: 'local-fake',
    },
  }
  const local = Object.create(runtime) as WebRuntime
  Object.defineProperties(local, {
    config: { value: localBindings(runtime.config) },
    ai: { value: { available: true, value: withMedia?.(ai) ?? ai } },
    health: {
      value: {
        cache: async () => {
          await runtime.cache.get('fault-local-health')
        },
        tasks: {
          queue: async () => ({ status: 'up' }),
          scheduler: async () => ({ status: 'up', lastCronAt: new Date().toISOString() }),
        },
      },
    },
  })
  return local
}
