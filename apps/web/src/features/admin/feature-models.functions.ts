import { log } from '@saas/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'
import { withAdminAction } from './action.server.ts'
import { adminMiddleware } from './admin.functions.ts'
import {
  changedFeatureModelEntries,
  featureModelsInput,
  readAdminFeatureModels,
} from './feature-models.ts'
import { invalidateRuntimeSettings, writeRuntimeSetting } from './settings.ts'

export const getAdminFeatureModels = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context }) => readAdminFeatureModels(context.db))

/** 只写有变化的功能，提交后按键清缓存。 */
export const saveAdminFeatureModels = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(featureModelsInput)
  .handler(async ({ context, data }) => {
    const entries = await changedFeatureModelEntries(context.db, data.values)
    if (entries.length === 0) return { ok: true as const }
    // 与 MCP settings.set 同一写入路径：定义校验、模型种类检查、加锁、新旧值与同事务审计
    await withAdminAction(context, 'setting.update', async (scope) => {
      for (const [key, value] of entries) await writeRuntimeSetting(scope, key, value)
    })
    try {
      await invalidateRuntimeSettings(
        getWebRuntime().cache,
        entries.map(([key]) => key),
      )
    } catch (error) {
      log.error('admin.settings_cache_invalidation_failed', {
        error,
        actorUserId: context.admin.id,
      })
      return { ok: false as const, error: 'cache' as const }
    }
    log.info('admin.feature_models_updated', { actorUserId: context.admin.id })
    return { ok: true as const }
  })
