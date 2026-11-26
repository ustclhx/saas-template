import { ADMIN_MAX_OFFSET } from '@web/features/admin/list.ts'
import { z } from 'zod'

export const studioReviewQueueSchema = z.strictObject({
  queue: z.enum(['pending', 'reported', 'hidden', 'removed']).default('pending'),
  site: z.string().trim().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
})

const workId = z.uuid()
const removalReason = z.string().trim().min(1).max(200)
// 下架说明只写入审计，作者看到的是原因（reason）
const removalNote = z.string().trim().max(500).optional()

export const studioModerationSchema = z.discriminatedUnion('action', [
  z.strictObject({ workId, action: z.literal('approve') }),
  z.strictObject({ workId, action: z.literal('remove'), reason: removalReason, note: removalNote }),
  z.strictObject({ workId, action: z.literal('restore') }),
  z.strictObject({ workId, action: z.literal('feature') }),
  z.strictObject({ workId, action: z.literal('unfeature') }),
])

export type StudioModerationInput = z.input<typeof studioModerationSchema>

/** 批量通过 / 下架（design 决策 8，P1）：每次最多 50 件，逐件独立 adminAction 与审计 */
export const STUDIO_BATCH_LIMIT = 50

export const studioBatchModerationSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('approve'),
    workIds: z.array(workId).min(1).max(STUDIO_BATCH_LIMIT),
  }),
  z.strictObject({
    action: z.literal('remove'),
    workIds: z.array(workId).min(1).max(STUDIO_BATCH_LIMIT),
    reason: removalReason,
    note: removalNote,
  }),
])

export type StudioBatchModerationInput = z.input<typeof studioBatchModerationSchema>
