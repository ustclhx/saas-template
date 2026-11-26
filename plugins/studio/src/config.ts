import { z } from 'zod'
import { STUDIO_KINDS } from './kinds.ts'

export const DEFAULT_PUBLISH_DAILY_LIMIT = 20

export const studioConfigSchema = z.strictObject({
  kinds: z.array(z.enum(STUDIO_KINDS)).default([...STUDIO_KINDS]),
  publishDailyLimit: z.int().positive().default(DEFAULT_PUBLISH_DAILY_LIMIT),
  reportHideThreshold: z.int().positive().default(3),
  galleryPageSize: z.int().positive().default(24),
})
