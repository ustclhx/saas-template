import { env } from 'cloudflare:workers'
import { defaultPricing, invalidateModelCache, modelValues, PricingError } from '@saas/ai'
import { aiModel } from '@saas/db'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import { withAdminAction } from '../admin/action.server.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'
import { ADMIN_PAGE_SIZE, adminListSearch } from '../admin/list.ts'
import { assertModelProviderEnabled } from './admin-model-provider.ts'

// 模型管理：服务端分页、类型筛选与排序；新增、编辑、复制、启用 / 停用。
// 计费方式由 @saas/ai 的 parsePricing 校验（按次文本模型缺 token 上限时拒绝保存）；
// 保存经 adminAction 包装（add-admin-console 1.1），审计与写入同事务；提交后使 KV 中的模型列表缓存失效。

const kinds = ['text', 'image', 'video'] as const

const modelInput = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  kind: z.enum(kinds),
  provider: z.string().trim().min(1).max(64),
  providerModelId: z.string().trim().min(1).max(200),
  pricing: z.unknown(),
  tags: z.array(z.string().trim().max(64)).max(50),
  enabled: z.boolean(),
  sort: z.number().int().min(-1_000_000).max(1_000_000),
})

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

type Result = { ok: true; id: string } | { ok: false; error: string }

/** 违反唯一约束（重复的模型 key）：postgres.js 的错误经 drizzle 包装后在 cause 中 */
function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause
  return cause?.code === '23505'
}

async function safe(action: () => Promise<string>): Promise<Result> {
  try {
    const id = await action()
    await invalidateModelCache(env.CACHE)
    return { ok: true, id }
  } catch (error) {
    if (error instanceof PricingError) return { ok: false, error: error.code }
    if (error instanceof AppError) return { ok: false, error: error.code }
    if (isUniqueViolation(error)) return { ok: false, error: 'MODEL_KEY_TAKEN' }
    throw error
  }
}

export const getAdminModels = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      offset: z.number().int().min(0).max(100_000),
      kind: z.string().max(200).optional(),
      order: z.string().max(200).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { offset, kind, order } = adminListSearch(['kind', 'order'])(data)
    const ordering =
      order === 'key'
        ? [asc(aiModel.key)]
        : order === 'key_desc'
          ? [desc(aiModel.key)]
          : order === 'sort_desc'
            ? [desc(aiModel.sort), asc(aiModel.key)]
            : [asc(aiModel.sort), asc(aiModel.key)]
    const rows = await context.db
      .select({
        id: aiModel.id,
        key: aiModel.key,
        kind: aiModel.kind,
        provider: aiModel.provider,
        providerModelId: aiModel.providerModelId,
        pricing: aiModel.pricing,
        tags: aiModel.minPlanFeatures,
        enabled: aiModel.enabled,
        sort: aiModel.sort,
      })
      .from(aiModel)
      .where(
        kind && kinds.includes(kind as (typeof kinds)[number])
          ? eq(aiModel.kind, kind as (typeof kinds)[number])
          : undefined,
      )
      .orderBy(...ordering)
      .offset(offset)
      .limit(ADMIN_PAGE_SIZE + 1)
    const modes = templateConfig.ai.defaultPricingMode
    return {
      // pricing 列来自 JSON，按 JSON 类型返回给页面
      hasMore: rows.length > ADMIN_PAGE_SIZE,
      models: rows
        .slice(0, ADMIN_PAGE_SIZE)
        .map((row) => ({ ...row, pricing: row.pricing as { [key: string]: Json } })),
      mediaProviders: templateConfig.ai.mediaProviders,
      defaults: Object.fromEntries(kinds.map((kind) => [kind, defaultPricing(kind, modes)])),
    }
  })

export const saveAdminModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(modelInput.extend({ id: z.uuid().optional() }))
  .handler(({ context, data }) =>
    safe(() =>
      withAdminAction(context, 'ai.model_save', async ({ tx, audit }) => {
        assertModelProviderEnabled(data.kind, data.provider, templateConfig.ai.mediaProviders)
        const values = modelValues(data)
        // 锁住旧行，保证并发改价时审计中的旧价格是本次实际覆盖的价格。
        const [before] = data.id
          ? await tx
              .select({ pricing: aiModel.pricing })
              .from(aiModel)
              .where(eq(aiModel.id, data.id))
              .for('update')
          : []
        if (data.id && !before) throw new AppError('NOT_FOUND', 'Model not found', { status: 404 })
        const [saved] = data.id
          ? await tx.update(aiModel).set(values).where(eq(aiModel.id, data.id)).returning()
          : await tx.insert(aiModel).values(values).returning()
        if (!saved) throw new AppError('NOT_FOUND', 'Model not found', { status: 404 })
        await audit({
          action: data.id ? 'ai.model_updated' : 'ai.model_created',
          targetType: 'ai_model',
          targetId: saved.id,
          meta: {
            key: saved.key,
            kind: saved.kind,
            pricing: saved.pricing,
            oldPricing: before?.pricing ?? null,
            newPricing: saved.pricing,
            enabled: saved.enabled,
          },
        })
        return saved.id
      }),
    ),
  )

export const setAdminModelEnabled = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.uuid(), enabled: z.boolean() }))
  .handler(({ context, data }) =>
    safe(() =>
      withAdminAction(context, 'ai.model_set_enabled', async ({ tx, audit }) => {
        const [saved] = await tx
          .update(aiModel)
          .set({ enabled: data.enabled })
          .where(eq(aiModel.id, data.id))
          .returning({ id: aiModel.id, key: aiModel.key })
        if (!saved) throw new AppError('NOT_FOUND', 'Model not found', { status: 404 })
        await audit({
          action: data.enabled ? 'ai.model_enabled' : 'ai.model_disabled',
          targetType: 'ai_model',
          targetId: saved.id,
          meta: { key: saved.key },
        })
        return saved.id
      }),
    ),
  )

/** 复制已保存的模型，包括媒体参数；副本先停用，审核后再启用。 */
export const copyAdminModel = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.uuid(), key: modelInput.shape.key }))
  .handler(({ context, data }) =>
    safe(() =>
      withAdminAction(context, 'ai.model_copy', async ({ tx, audit }) => {
        const [source] = await tx.select().from(aiModel).where(eq(aiModel.id, data.id)).for('share')
        if (!source) throw new AppError('NOT_FOUND', 'Model not found', { status: 404 })
        assertModelProviderEnabled(source.kind, source.provider, templateConfig.ai.mediaProviders)
        const values = modelValues({
          ...source,
          key: data.key,
          tags: source.minPlanFeatures,
          enabled: false,
        })
        const [saved] = await tx
          .insert(aiModel)
          .values({ ...values, paramsSchema: source.paramsSchema })
          .returning()
        if (!saved) throw new AppError('NOT_FOUND', 'Model not found', { status: 404 })
        await audit({
          action: 'ai.model_copied',
          targetType: 'ai_model',
          targetId: saved.id,
          meta: {
            sourceId: source.id,
            sourceKey: source.key,
            key: saved.key,
            pricing: saved.pricing,
            enabled: saved.enabled,
          },
        })
        return saved.id
      }),
    ),
  )
