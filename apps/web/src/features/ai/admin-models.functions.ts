import { defaultPricing, invalidateModelCache, PricingError } from '@saas/ai'
import { getMediaProviders, isAiFaultInjectionEnabled } from '@saas/config'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withBilling } from '../../server/feature-gates.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { withAdminAction } from '../admin/action.server.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'
import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE, adminListSearch } from '../admin/list.ts'
import { availableMediaProviders } from './admin-model-provider.ts'
import { adminModelInput, adminModelKey, adminModelKinds } from './admin-models.schema.ts'
import {
  copyAdminModelRecord,
  listAdminModels,
  saveAdminModelRecord,
  setAdminModelRecordEnabled,
} from './admin-models.ts'

function modelRuntimeCapabilities() {
  const ai = getWebRuntime().ai
  return {
    workersAiAvailable: ai?.available === true && ai.value.workersAi.available,
    aiFaultInjectionEnabled: isAiFaultInjectionEnabled(
      ai?.available === true ? ai.value.config : {},
    ),
  }
}

type Result = { ok: true; id: string } | { ok: false; error: string; message?: string }

/** 违反唯一约束（重复的模型 key）：postgres.js 的错误经 drizzle 包装后在 cause 中 */
function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause
  return cause?.code === '23505'
}

async function safe(action: () => Promise<string>): Promise<Result> {
  try {
    const id = await action()
    await invalidateModelCache(getWebRuntime().cache)
    return { ok: true, id }
  } catch (error) {
    if (error instanceof PricingError) return { ok: false, error: error.code }
    if (error instanceof AppError) return { ok: false, error: error.code, message: error.message }
    if (isUniqueViolation(error)) return { ok: false, error: 'MODEL_KEY_TAKEN' }
    throw error
  }
}

export const getAdminModels = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(
    z.object({
      offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET),
      kind: z.string().max(200).optional(),
      order: z.string().max(200).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const search = adminListSearch(['kind', 'order'])(data)
    const result = await listAdminModels(context.db, { ...search, limit: ADMIN_PAGE_SIZE })
    const modes = templateConfig.ai.defaultPricingMode
    return {
      ...result,
      mediaProviders: availableMediaProviders(
        getMediaProviders(templateConfig),
        modelRuntimeCapabilities().workersAiAvailable,
      ),
      defaults: Object.fromEntries(
        adminModelKinds.map((kind) => [kind, defaultPricing(kind, modes)]),
      ),
    }
  })

export const saveAdminModel = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(adminModelInput.extend({ id: z.uuid().optional() }))
  .handler(({ context, data }) =>
    safe(() =>
      withAdminAction(
        context,
        { name: 'ai.model_save', input: { id: data.id, pricing: data.pricing } },
        (scope) => saveAdminModelRecord(scope, data, modelRuntimeCapabilities()),
      ),
    ),
  )

export const setAdminModelEnabled = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(z.object({ id: z.uuid(), enabled: z.boolean() }))
  .handler(({ context, data }) =>
    safe(() =>
      withAdminAction(context, 'ai.model_toggle', (scope) =>
        setAdminModelRecordEnabled(scope, data, modelRuntimeCapabilities()),
      ),
    ),
  )

export const copyAdminModel = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(z.object({ id: z.uuid(), key: adminModelKey, paramsSchema: z.string() }))
  .handler(({ context, data }) =>
    safe(() =>
      withAdminAction(context, 'ai.model_copy', (scope) =>
        copyAdminModelRecord(scope, data, modelRuntimeCapabilities()),
      ),
    ),
  )
