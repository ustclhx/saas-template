import { ADMIN_MAX_OFFSET } from '@web/features/admin/list.ts'
import { z } from 'zod'

const reviewQueue = z.enum(['pending', 'reported', 'hidden', 'removed'])
export const studioReviewCursor = z.tuple([reviewQueue, z.iso.datetime(), z.uuid()])

export const studioReviewQueueSchema = z.strictObject({
  queue: reviewQueue.default('pending'),
  site: z.string().trim().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
})

export const studioModerationFields = { workId: z.uuid() }
export const studioRemovalReason = z.string().trim().min(1).max(200)

export const studioModerationSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...studioModerationFields, action: z.literal('approve') }),
  z.strictObject({
    ...studioModerationFields,
    action: z.literal('remove'),
    reason: studioRemovalReason,
  }),
  z.strictObject({ ...studioModerationFields, action: z.literal('restore') }),
  z.strictObject({ ...studioModerationFields, action: z.literal('feature') }),
  z.strictObject({ ...studioModerationFields, action: z.literal('unfeature') }),
])

export type StudioModerationInput = z.input<typeof studioModerationSchema>
