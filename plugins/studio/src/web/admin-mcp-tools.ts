import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE, offsetOfPage } from '@web/features/admin/list.ts'
import {
  definePluginAdminMcpTool,
  dryRunDescription,
  toolResult,
} from '@web/features/admin/mcp-tool.ts'
import { z } from 'zod'
import { applyStudioModeration, studioAdminActionName } from './moderation.server.ts'
import {
  studioModerationFields,
  studioModerationSchema,
  studioRemovalReason,
  studioReviewCursor,
  studioReviewQueueSchema,
} from './moderation-input.ts'
import { listStudioReviewQueue } from './moderation-queue.server.ts'
import { invalidateStudioMedia } from './work-invalidation.ts'

const maxPage = ADMIN_MAX_OFFSET / ADMIN_PAGE_SIZE + 1

export const studioWorksList = definePluginAdminMcpTool({
  scope: 'admin:read',
  description: 'List Studio works in an administrator review queue with report reason counts.',
  input: z
    .strictObject({
      tab: studioReviewQueueSchema.shape.queue,
      site: studioReviewQueueSchema.shape.site,
      page: z.number().int().min(1).max(maxPage).optional(),
      cursor: z.string().max(100).optional(),
    })
    .refine(({ page, cursor, tab }) => {
      if (cursor === undefined) return true
      const parsed = studioReviewCursor.safeParse(cursor.split('~'))
      return page === undefined && parsed.success && parsed.data[0] === tab
    }),
  params: {
    tab: 'Review tab: pending, reported, hidden, or removed. Defaults to pending.',
    site: 'Optional site key. Omit to list works across sites.',
    page: `One-based page number (1–${maxPage}), with ${ADMIN_PAGE_SIZE} works per page. Omit when using cursor.`,
    cursor: 'Pass nextCursor from the previous result with the same tab and site. Omit page.',
  },
  async run({ db }, { tab, site, page = 1, cursor }) {
    const position = cursor === undefined ? undefined : studioReviewCursor.parse(cursor.split('~'))
    const result = await listStudioReviewQueue(
      db,
      { queue: tab, site, offset: offsetOfPage(page - 1) },
      { cursor: position },
    )
    return toolResult(result)
  },
})

export const studioWorksModerate = definePluginAdminMcpTool({
  scope: 'admin:write',
  description: 'Preview or apply an administrator moderation action to a Studio work.',
  input: z
    .strictObject({
      ...studioModerationFields,
      action: z.enum(studioModerationSchema.options.map(({ shape }) => shape.action.value)),
      reason: studioRemovalReason.optional(),
      dryRun: z.boolean().optional(),
    })
    .refine(({ action, reason }) => (action === 'remove') === (reason !== undefined)),
  params: {
    workId: 'Studio work UUID from studio.works.list.',
    action: 'Moderation action: approve, remove, restore, feature, or unfeature.',
    reason: 'Removal reason, required for remove only. Use 1–200 characters after trimming.',
    dryRun: dryRunDescription,
  },
  adminAction: ({ action }) => studioAdminActionName(action),
  async run(ctx, { dryRun: _, ...input }) {
    const data = studioModerationSchema.parse(input)
    const { work, invalidate } = await applyStudioModeration(ctx, data, { dryRun: ctx.dryRun })
    if (invalidate) ctx.afterCommit(() => invalidateStudioMedia(invalidate))
    return toolResult({ work, dryRun: ctx.dryRun })
  },
})
