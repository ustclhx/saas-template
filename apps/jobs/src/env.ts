import { type Env, envSchema, loadEnv } from '@saas/config'

/** apps/jobs 需要的环境变量与绑定。 */
export const jobsEnvSchema = envSchema

/**
 * 处理任何事件之前校验环境（specs/runtime-config「环境变量启动校验」）。
 * 失败时抛出 `EnvValidationError`，其消息只含变量名：Cron 记为失败，Queue 消息按重试策略重投。
 */
export function requireEnv(env: unknown): Env {
  return loadEnv(env, jobsEnvSchema)
}
