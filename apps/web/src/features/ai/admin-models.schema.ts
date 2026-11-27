import { z } from 'zod'

export const adminModelKinds = ['text', 'image', 'video'] as const
export const MODEL_DISPLAY_NAME_MAX_LENGTH = 60

export const adminModelDisplayName = z.string().trim().max(MODEL_DISPLAY_NAME_MAX_LENGTH).nullable()

export const adminModelKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

/**
 * 备用模型链的传输形态；数量（≤ 2）、类型、服务商与参数兼容由 @saas/ai 的
 * validateModelFallbacks 统一校验，以便后台与 Admin MCP 返回同样的原因。
 */
export const adminModelFallbacks = z
  .array(
    z.strictObject({
      modelKey: z.string().trim().min(1).max(64),
      paramMap: z.record(z.string().max(200), z.string().max(200)).optional(),
    }),
  )
  .max(10)

export const adminModelInput = z.object({
  key: adminModelKey,
  displayName: adminModelDisplayName.optional(),
  kind: z.enum(adminModelKinds),
  provider: z.string().trim().min(1).max(64),
  providerModelId: z.string().trim().min(1).max(200),
  pricing: z.unknown(),
  paramsSchema: z.string(),
  tags: z.array(z.string().trim().max(64)).max(50),
  enabled: z.boolean(),
  supportsTools: z.boolean().optional(),
  fallbacks: adminModelFallbacks.optional(),
  sort: z.number().int().min(-1_000_000).max(1_000_000),
})
