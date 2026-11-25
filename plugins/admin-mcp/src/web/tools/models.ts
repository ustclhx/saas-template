import { invalidateModelCache, PricingError } from '@saas/ai'
import { AppError } from '@saas/shared'
import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { adminModelKey, adminModelKinds } from '@web/features/ai/admin-models.schema.ts'
import { listAdminModels, updateAdminModelByKey } from '@web/features/ai/admin-models.ts'
import { requireFeature } from '@web/server/feature-gates.ts'
import { z } from 'zod'
import { defineAdminTool, toolResult } from './define.ts'

const list = defineAdminTool({
  name: 'models.list',
  scope: 'admin:read',
  description: 'List AI models with their status, parameters, and pricing.',
  input: z.strictObject({
    offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
    limit: z.number().int().min(1).max(ADMIN_PAGE_SIZE).default(ADMIN_PAGE_SIZE),
    kind: z.enum(adminModelKinds).optional(),
    order: z.enum(['sort', 'sort_desc', 'key', 'key_desc']).optional(),
  }),
  async run({ db }, { kind, order, ...paging }) {
    requireFeature('billing')
    return toolResult(
      await listAdminModels(db, { ...paging, ...(kind && { kind }), ...(order && { order }) }),
    )
  },
})

const update = defineAdminTool({
  name: 'models.update',
  scope: 'admin:write',
  description: 'Update an existing model by key. Supply enabled, pricing, or paramsSchema.',
  input: z
    .strictObject({
      key: adminModelKey,
      enabled: z.boolean().optional(),
      pricing: z.record(z.string(), z.unknown()).optional(),
      paramsSchema: z.record(z.string(), z.unknown()).optional(),
      dryRun: z.boolean().optional(),
    })
    .refine(
      ({ enabled, pricing, paramsSchema }) =>
        enabled !== undefined || pricing !== undefined || paramsSchema !== undefined,
      'Supply at least one of enabled, pricing, or paramsSchema.',
    ),
  async run(ctx, { key, enabled, pricing, paramsSchema }) {
    requireFeature('billing')
    try {
      return toolResult(
        await updateAdminModelByKey(
          ctx,
          {
            key,
            enabled,
            pricing,
            paramsSchema: paramsSchema === undefined ? undefined : JSON.stringify(paramsSchema),
          },
          ctx,
          ctx.dryRun,
        ),
      )
    } catch (error) {
      if (error instanceof PricingError) {
        throw new AppError(error.code, 'Invalid model pricing', { status: 400 })
      }
      if (error instanceof AppError && error.code === 'ACCEPTANCE_FAULT_INVALID') {
        throw new AppError(error.code, 'Invalid model configuration', { status: 400 })
      }
      if (error instanceof AppError && error.expose && error.status < 500) {
        throw new AppError(error.code, 'Model update failed', { status: error.status })
      }
      throw error
    }
  },
  afterCommit: ({ cache }) => invalidateModelCache(cache),
})

export const modelTools = [list, update] as const
