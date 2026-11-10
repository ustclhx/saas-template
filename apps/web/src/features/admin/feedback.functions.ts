import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { adminAction } from './action.server.ts'
import { adminMiddleware } from './admin.functions.ts'
import { deleteFeedback, feedbackSearchSchema, feedbackStats, listFeedback } from './feedback.ts'

export const getAdminFeedback = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(feedbackSearchSchema)
  .handler(async ({ context, data }) => {
    const [list, stats] = await Promise.all([
      listFeedback(context.db, data),
      feedbackStats(context.db, { from: data.from, to: data.to }),
    ])
    return { ...list, stats }
  })

export const deleteAdminFeedback = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.strictObject({ id: z.uuid() }))
  .handler(
    adminAction('ai.feedback.delete', ({ data, ...scope }) => deleteFeedback(scope, data.id)),
  )
