import { invalidateModelCache, PricingError } from '@saas/ai'
import { aiModel } from '@saas/db'
import { AppError } from '@saas/shared'
import type { AdminActionScope } from '@web/features/admin/action.ts'
import {
  ConfirmationFailedError,
  fingerprint,
  STALE_TARGET,
} from '@web/features/admin/confirmations/service.ts'
import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { adminModelKey, adminModelKinds } from '@web/features/ai/admin-models.schema.ts'
import { listAdminModels, updateAdminModelByKey } from '@web/features/ai/admin-models.ts'
import { requireFeature } from '@web/server/feature-gates.ts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { defineAdminTool, dryRunDescription, pagingDescriptions, toolResult } from './define.ts'

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
  params: {
    ...pagingDescriptions,
    kind: 'Filter by model kind (text, image, or video).',
    order:
      'Sort by configured order (sort or sort_desc) or by model key (key or key_desc). Defaults to sort.',
  },
  async run({ db }, { kind, order, ...paging }) {
    requireFeature('billing')
    return toolResult(
      await listAdminModels(db, { ...paging, ...(kind && { kind }), ...(order && { order }) }),
    )
  },
})

interface ModelUpdate {
  readonly key: string
  readonly enabled?: boolean | undefined
  readonly pricing?: Record<string, unknown> | undefined
  readonly paramsSchema?: Record<string, unknown> | undefined
}

/** 复用后台模型保存的校验；对外只暴露稳定的错误码与固定消息 */
async function applyModelUpdate(
  scope: AdminActionScope,
  capabilities: { workersAiAvailable: boolean; aiFaultInjectionEnabled: boolean },
  { key, enabled, pricing, paramsSchema }: ModelUpdate,
  dryRun: boolean,
) {
  try {
    return await updateAdminModelByKey(
      scope,
      {
        key,
        enabled,
        pricing,
        paramsSchema: paramsSchema === undefined ? undefined : JSON.stringify(paramsSchema),
      },
      capabilities,
      dryRun,
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
}

/** 确认时比对的模型快照：启用状态、定价与参数 */
async function modelSnapshot(scope: Pick<AdminActionScope, 'tx'>, key: string, lock: boolean) {
  const query = scope.tx
    .select({
      id: aiModel.id,
      enabled: aiModel.enabled,
      pricing: aiModel.pricing,
      paramsSchema: aiModel.paramsSchema,
    })
    .from(aiModel)
    .where(eq(aiModel.key, key))
  const [model] = lock ? await query.for('update') : await query
  if (!model) throw new AppError('MODEL_NOT_FOUND', 'Model not found', { status: 404 })
  const { id, ...state } = model
  return { id, fingerprint: await fingerprint(state) }
}

const modelPayload = z.object({
  key: z.string(),
  enabled: z.boolean().optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
  paramsSchema: z.record(z.string(), z.unknown()).optional(),
  snapshot: z.string(),
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
  params: {
    key: 'Existing model key from models.list.',
    enabled: 'Set to true to enable the model or false to disable it.',
    pricing: 'Complete replacement pricing object for this model.',
    paramsSchema: 'Complete replacement parameter schema as a JSON object.',
    dryRun: dryRunDescription,
  },
  adminAction: ({ key, pricing }) => ({ name: 'ai.model_save', input: { key, pricing } }),
  async run(ctx, { dryRun: _dryRun, ...input }) {
    requireFeature('billing')
    return toolResult(await applyModelUpdate(ctx, ctx, input, ctx.dryRun))
  },
  afterCommit: ({ cache }) => invalidateModelCache(cache),
  // 只有改动定价时才走确认（ai.model_save 的判定）；启停与参数单独修改照常直接写入
  async confirm(ctx, { dryRun: _dryRun, ...input }) {
    requireFeature('billing')
    const preview = await applyModelUpdate(ctx, ctx, input, true)
    const { id, fingerprint: snapshot } = await modelSnapshot(ctx, input.key, false)
    return {
      summary: `Update model ${input.key}: ${Object.keys(preview.changes).join(', ')}`,
      display: { kind: 'model', id, key: input.key, changes: preview.changes },
      payload: { ...input, snapshot },
    }
  },
  execute: (env) => ({
    kind: 'transaction',
    async run(scope, { record }) {
      requireFeature('billing')
      const { snapshot, ...input } = modelPayload.parse(record.payload)
      if ((await modelSnapshot(scope, input.key, true)).fingerprint !== snapshot)
        throw new ConfirmationFailedError(STALE_TARGET, 'The model changed after the request')
      const { changes } = await applyModelUpdate(scope, env, input, false)
      return { key: input.key, changes }
    },
    afterCommit: () => invalidateModelCache(env.cache),
  }),
})

export const modelTools = [list, update] as const
