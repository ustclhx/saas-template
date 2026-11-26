import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { adminMiddleware } from '@web/features/admin/admin.functions.ts'
import { requireFileStorage } from '@web/features/files/runtime.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { z } from 'zod'
import {
  studioBatchModerationSchema,
  studioModerationSchema,
  studioReviewQueueSchema,
} from './moderation-input.ts'
import { invalidateStudioMedia, invalidateStudioMediaMany } from './work-invalidation.ts'

function studioRuntime() {
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio'))
    throw new AppError('STUDIO_UNAVAILABLE', 'Studio is unavailable', { status: 503 })
  return runtime
}

export const listAdminStudioWorks = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(studioReviewQueueSchema)
  .handler(async ({ context, data }) => {
    studioRuntime()
    const { countStudioReviewTabs, listStudioReviewQueue } = await import(
      './moderation-queue.server.ts'
    )
    const list = await listStudioReviewQueue(context.db, data)
    return { ...list, counts: await countStudioReviewTabs(context.db) }
  })

export const getAdminStudioWorkCount = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(async ({ context }) => {
    studioRuntime()
    const { countStudioReviewQueue } = await import('./moderation-queue.server.ts')
    return countStudioReviewQueue(context.db)
  })

export const getAdminStudioWorkPreview = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(z.strictObject({ workId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const runtime = studioRuntime()
    const { getStudioReviewMedia } = await import('./moderation-queue.server.ts')
    setResponseHeader('cache-control', 'private, no-store')
    return getStudioReviewMedia(context.db, requireFileStorage(runtime), data.workId)
  })

export const moderateAdminStudioWork = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(studioModerationSchema)
  .handler(async ({ context, data }) => {
    studioRuntime()
    const { moderateStudioWork } = await import('./moderation.server.ts')
    return moderateStudioWork(context, data, invalidateStudioMedia)
  })

export const moderateAdminStudioWorks = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(studioBatchModerationSchema)
  .handler(async ({ context, data }) => {
    studioRuntime()
    const { moderateStudioWorks } = await import('./moderation.server.ts')
    return moderateStudioWorks(context, data, invalidateStudioMediaMany)
  })
