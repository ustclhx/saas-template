import { EnvValidationError, envSchema, loadEnv } from '@saas/config'
import { z } from 'zod'

/** 绑定对象上必须存在的方法（只检查形状，不读取任何取值） */
const bindingWith = <T>(...methods: string[]) =>
  z.custom<T>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function'),
  )

/** apps/web 需要的环境变量与绑定：共享 schema 加上 web 独有的绑定。 */
export const webEnvSchema = envSchema.extend({
  AI_MEDIA_WORKFLOW: bindingWith<Cloudflare.Env['AI_MEDIA_WORKFLOW']>('create', 'get'),
  EMAIL_QUEUE: bindingWith<Cloudflare.Env['EMAIL_QUEUE']>('send'),
})

/** 已校验通过的 env 对象；env 在一个 isolate 内不变，校验一次即可。 */
const validated = new WeakSet<object>()

/**
 * 请求入口的环境校验（specs/runtime-config「环境变量启动校验」）。
 * 校验通过返回 `null`；失败时只在日志中列出变量名，并返回不含任何细节的 500。
 */
export function checkEnv(env: unknown): Response | null {
  if (typeof env === 'object' && env !== null && validated.has(env)) return null
  try {
    loadEnv(env, webEnvSchema)
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error
    console.error(
      JSON.stringify({ event: 'env.invalid', missing: error.missing, invalid: error.invalid }),
    )
    return new Response('Internal Server Error', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (typeof env === 'object' && env !== null) validated.add(env)
  return null
}
