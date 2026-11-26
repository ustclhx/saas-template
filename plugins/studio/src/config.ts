import { z } from 'zod'
import { STUDIO_KINDS } from './kinds.ts'

export const DEFAULT_PUBLISH_DAILY_LIMIT = 20

export const studioConfigSchema = z.strictObject({
  kinds: z.array(z.enum(STUDIO_KINDS)).default([...STUDIO_KINDS]),
  publishDailyLimit: z.int().positive().default(DEFAULT_PUBLISH_DAILY_LIMIT),
  reportHideThreshold: z.int().positive().default(3),
  galleryPageSize: z.int().positive().default(24),
  sites: z
    .record(
      z.string().min(1),
      z.url({ protocol: /^https?$/ }).pipe(
        z.string().refine((url) => new URL(url).origin === url, {
          message: 'Use an origin without a path, query or trailing slash',
        }),
      ),
    )
    .refine((sites) => new Set(Object.values(sites)).size === Object.keys(sites).length, {
      message: 'Each Studio site must have its own origin',
    })
    .optional(),
})
