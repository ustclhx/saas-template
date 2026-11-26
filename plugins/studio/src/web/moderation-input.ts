import { ADMIN_MAX_OFFSET } from '@web/features/admin/list.ts'
import { z } from 'zod'

export const studioReviewQueueSchema = z.strictObject({
  queue: z.enum(['pending', 'reported', 'hidden', 'removed']).default('pending'),
  site: z.string().trim().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
})

const workId = z.uuid()
const removalReason = z.string().trim().min(1).max(200)

export const studioModerationSchema = z.discriminatedUnion('action', [
  z.strictObject({ workId, action: z.literal('approve') }),
  z.strictObject({ workId, action: z.literal('remove'), reason: removalReason }),
  z.strictObject({ workId, action: z.literal('restore') }),
  z.strictObject({ workId, action: z.literal('feature') }),
  z.strictObject({ workId, action: z.literal('unfeature') }),
])

export type StudioModerationInput = z.input<typeof studioModerationSchema>
