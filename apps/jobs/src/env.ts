import {
  type AiFaultInjectionEnv,
  envSchema,
  loadEnv,
  pluginBindingsShape,
  validateAiFaultInjectionEnv,
  withEmailEnv,
} from '@saas/config'
import { z } from 'zod'
import jobsPlugins from './plugins.gen.ts'

/** apps/jobs 需要的环境变量与绑定：共享 schema 加上邮件发送通道（EMAIL_QUEUE 消费者）。 */
export const jobsEnvSchema = withEmailEnv(envSchema)

/** 启用插件清单声明的 jobs 绑定（plugins.gen.ts）：必需绑定缺失时与核心绑定一样校验失败 */
export const jobsPluginBindingsSchema = z.object(
  pluginBindingsShape(jobsPlugins.flatMap((plugin) => plugin.bindings)),
)

/**
 * 处理任何事件之前校验环境（specs/runtime-config「环境变量启动校验」）。
 * 失败时抛出 `EnvValidationError`，其消息只含变量名：Cron 记为失败，Queue 消息按重试策略重投。
 */
export function requireEnv(env: unknown) {
  validateAiFaultInjectionEnv((env ?? {}) as AiFaultInjectionEnv)
  loadEnv(env, jobsPluginBindingsSchema)
  return loadEnv(env, jobsEnvSchema)
}
