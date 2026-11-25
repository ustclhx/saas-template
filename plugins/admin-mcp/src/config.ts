import { z } from 'zod'

export const adminMcpConfigSchema = z.strictObject({
  rateLimitPerMinute: z.int().min(1).default(120),
  maxTokenDays: z.int().min(1).max(365).default(365),
})
