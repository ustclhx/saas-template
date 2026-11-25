import { z } from 'zod'

export const adminModelKinds = ['text', 'image', 'video'] as const

export const adminModelKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

export const adminModelInput = z.object({
  key: adminModelKey,
  kind: z.enum(adminModelKinds),
  provider: z.string().trim().min(1).max(64),
  providerModelId: z.string().trim().min(1).max(200),
  pricing: z.unknown(),
  paramsSchema: z.string(),
  tags: z.array(z.string().trim().max(64)).max(50),
  enabled: z.boolean(),
  supportsTools: z.boolean().optional(),
  sort: z.number().int().min(-1_000_000).max(1_000_000),
})
