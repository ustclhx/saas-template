import { type ModelInput, modelValues, parseAcceptanceFault } from '@saas/ai'
import { getMediaProviders } from '@saas/config'
import { aiModel, type Database } from '@saas/db'
import { AppError } from '@saas/shared'
import { asc, desc, eq, type SQL } from 'drizzle-orm'
import { templateConfig } from '../../server/template-config.ts'
import type { AdminActionScope, AdminTransaction } from '../admin/action.ts'
import type { AdminListSearch } from '../admin/list.ts'
import { parseAdminParamsSchema } from './admin-model-params.ts'
import { assertModelProviderEnabled } from './admin-model-provider.ts'
import { adminModelKinds } from './admin-models.schema.ts'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Model = typeof aiModel.$inferSelect
type ModelSettings = Pick<Model, 'enabled' | 'pricing' | 'paramsSchema'>
type ModelPatch = { [Field in keyof ModelSettings]?: ModelSettings[Field] | undefined }
type ModelSaveInput = Omit<ModelInput, 'paramsSchema'> & { paramsSchema: string | null }

interface ModelRuntimeCapabilities {
  readonly workersAiAvailable: boolean
  readonly aiFaultInjectionEnabled: boolean
}

export async function listAdminModels(
  db: Database,
  { offset, limit, kind, order }: AdminListSearch<'kind' | 'order'> & { limit: number },
) {
  const ordering =
    order === 'key'
      ? [asc(aiModel.key)]
      : order === 'key_desc'
        ? [desc(aiModel.key)]
        : order === 'sort_desc'
          ? [desc(aiModel.sort), asc(aiModel.key)]
          : [asc(aiModel.sort), asc(aiModel.key)]
  const selectedKind = adminModelKinds.find((value) => value === kind)
  const rows = await db
    .select({
      id: aiModel.id,
      key: aiModel.key,
      kind: aiModel.kind,
      provider: aiModel.provider,
      providerModelId: aiModel.providerModelId,
      pricing: aiModel.pricing,
      paramsSchema: aiModel.paramsSchema,
      tags: aiModel.minPlanFeatures,
      enabled: aiModel.enabled,
      supportsTools: aiModel.supportsTools,
      sort: aiModel.sort,
    })
    .from(aiModel)
    .where(selectedKind ? eq(aiModel.kind, selectedKind) : undefined)
    .orderBy(...ordering)
    .offset(offset)
    .limit(limit + 1)
  return {
    hasMore: rows.length > limit,
    models: rows.slice(0, limit).map((row) => ({
      ...row,
      pricing: row.pricing as { [key: string]: Json },
      paramsSchema: row.paramsSchema as { [key: string]: Json } | null,
    })),
  }
}

function assertAdminFaultConfig(
  model: Parameters<typeof parseAcceptanceFault>[0],
  capabilities: ModelRuntimeCapabilities,
) {
  const fault = parseAcceptanceFault(model)
  if (fault && !capabilities.aiFaultInjectionEnabled) {
    throw new AppError(
      'AI_FAULT_INJECTION_DISABLED',
      'Acceptance fault models require staging fault injection to be enabled.',
      { status: 400 },
    )
  }
  return fault
}

function assertProvider(
  model: Pick<Model, 'provider' | 'kind'>,
  { workersAiAvailable }: ModelRuntimeCapabilities,
) {
  assertModelProviderEnabled(
    model.kind,
    model.provider,
    getMediaProviders(templateConfig),
    workersAiAvailable,
  )
}

function validatedModelValues(input: ModelSaveInput, capabilities: ModelRuntimeCapabilities) {
  assertProvider(input, capabilities)
  const paramsSchema =
    input.paramsSchema === null ? null : parseAdminParamsSchema(input.kind, input.paramsSchema)
  assertAdminFaultConfig({ ...input, paramsSchema }, capabilities)
  return { ...modelValues({ ...input, paramsSchema }), paramsSchema }
}

function validateEnabled(model: Model, enabled: boolean, capabilities: ModelRuntimeCapabilities) {
  // 停用不受配置校验限制，确保遗留模型可清理。
  if (!enabled) return
  const fault = assertAdminFaultConfig(model, capabilities)
  if (fault || (model.provider === 'workers-ai' && !capabilities.workersAiAvailable)) {
    assertProvider(model, capabilities)
  }
}

function modelNotFound() {
  return new AppError('NOT_FOUND', 'Model not found', { status: 404 })
}

async function readModel(tx: AdminTransaction, where: SQL, lock: 'update' | 'share' | null) {
  const query = tx.select().from(aiModel).where(where)
  const [model] = lock ? await query.for(lock) : await query
  if (!model) throw modelNotFound()
  return model
}

/** 只记录 JSON 摘要，避免把 prompt 等参数默认值全文写入审计。 */
async function schemaHash(schema: Record<string, unknown> | null): Promise<string | null> {
  if (schema === null) return null
  const bytes = new TextEncoder().encode(JSON.stringify(schema))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function modelChanges(
  before: ModelSettings | undefined,
  after: ModelSettings,
  fields: ModelPatch = after,
) {
  return {
    ...(fields.enabled !== undefined && {
      enabled: { before: before?.enabled ?? null, after: after.enabled },
    }),
    ...(fields.pricing !== undefined && {
      pricing: { before: before?.pricing ?? null, after: after.pricing },
    }),
    ...(fields.paramsSchema !== undefined && {
      paramsSchema: { before: before?.paramsSchema ?? null, after: after.paramsSchema },
    }),
  }
}

async function paramsSchemaHashes(before: Model | undefined, after: Model) {
  return {
    before: await schemaHash(before?.paramsSchema ?? null),
    after: await schemaHash(after.paramsSchema),
  }
}

async function auditSavedModel(
  audit: AdminActionScope['audit'],
  before: Model | undefined,
  saved: Model,
  fields?: ModelPatch,
) {
  const paramsSchema = await paramsSchemaHashes(before, saved)
  const changes = modelChanges(before, saved, fields)
  await audit({
    action: before ? 'ai.model_updated' : 'ai.model_created',
    targetType: 'ai_model',
    targetId: saved.id,
    meta: {
      key: saved.key,
      kind: saved.kind,
      pricing: saved.pricing,
      oldPricing: before?.pricing ?? null,
      newPricing: saved.pricing,
      enabled: saved.enabled,
      supportsTools: { before: before?.supportsTools ?? null, after: saved.supportsTools },
      paramsSchema,
      changes: { ...changes, ...(changes.paramsSchema && { paramsSchema }) },
    },
  })
}

async function auditModelEnabled(audit: AdminActionScope['audit'], before: Model, saved: Model) {
  await audit({
    action: saved.enabled ? 'ai.model_enabled' : 'ai.model_disabled',
    targetType: 'ai_model',
    targetId: saved.id,
    meta: { key: saved.key, changes: modelChanges(before, saved, { enabled: saved.enabled }) },
  })
}

async function updateModel(tx: AdminTransaction, id: string, values: ModelPatch) {
  const [saved] = await tx.update(aiModel).set(values).where(eq(aiModel.id, id)).returning()
  if (!saved) throw modelNotFound()
  return saved
}

export async function saveAdminModelRecord(
  { tx, audit }: AdminActionScope,
  input: ModelSaveInput & { id?: string | undefined },
  capabilities: ModelRuntimeCapabilities,
) {
  const values = validatedModelValues(input, capabilities)
  // 锁住旧行，保证并发编辑时审计中的旧值是本次实际覆盖的值。
  const before = input.id ? await readModel(tx, eq(aiModel.id, input.id), 'update') : undefined
  const [saved] = input.id
    ? await tx.update(aiModel).set(values).where(eq(aiModel.id, input.id)).returning()
    : await tx.insert(aiModel).values(values).returning()
  if (!saved) throw modelNotFound()
  await auditSavedModel(audit, before, saved)
  return saved.id
}

export async function setAdminModelRecordEnabled(
  { tx, audit }: AdminActionScope,
  input: { id: string; enabled: boolean },
  capabilities: ModelRuntimeCapabilities,
) {
  const before = await readModel(tx, eq(aiModel.id, input.id), 'update')
  validateEnabled(before, input.enabled, capabilities)
  const saved = await updateModel(tx, input.id, { enabled: input.enabled })
  await auditModelEnabled(audit, before, saved)
  return saved.id
}

interface ModelUpdateInput {
  readonly key: string
  readonly enabled?: boolean | undefined
  readonly pricing?: unknown
  readonly paramsSchema?: string | undefined
}

/** 更新现有模型的运行时配置。调用方负责在已校验的管理员事务中执行。 */
export async function updateAdminModelByKey(
  { tx, audit }: AdminActionScope,
  input: ModelUpdateInput,
  capabilities: ModelRuntimeCapabilities,
  dryRun: boolean,
) {
  const before = await readModel(tx, eq(aiModel.key, input.key), dryRun ? null : 'update')
  if (
    input.enabled !== undefined &&
    input.pricing === undefined &&
    input.paramsSchema === undefined
  ) {
    validateEnabled(before, input.enabled, capabilities)
    const values = { enabled: input.enabled }
    const after = dryRun ? { ...before, ...values } : await updateModel(tx, before.id, values)
    if (!dryRun) await auditModelEnabled(audit, before, after)
    return { id: before.id, key: before.key, changes: modelChanges(before, after, values), dryRun }
  }

  const validated = validatedModelValues(
    {
      ...before,
      tags: before.minPlanFeatures,
      enabled: input.enabled ?? before.enabled,
      pricing: input.pricing === undefined ? before.pricing : input.pricing,
      paramsSchema:
        input.paramsSchema ??
        (before.paramsSchema === null ? null : JSON.stringify(before.paramsSchema)),
    },
    capabilities,
  )
  const values = {
    ...(input.enabled !== undefined && { enabled: validated.enabled }),
    ...(input.pricing !== undefined && { pricing: validated.pricing }),
    ...(input.paramsSchema !== undefined && { paramsSchema: validated.paramsSchema }),
  }
  const after = dryRun ? { ...before, ...values } : await updateModel(tx, before.id, values)
  if (!dryRun) await auditSavedModel(audit, before, after, values)
  return { id: before.id, key: before.key, changes: modelChanges(before, after, values), dryRun }
}

/** 复制已保存的模型，包括媒体参数；副本先停用，审核后再启用。 */
export async function copyAdminModelRecord(
  { tx, audit }: AdminActionScope,
  input: { id: string; key: string; paramsSchema: string },
  capabilities: ModelRuntimeCapabilities,
) {
  const source = await readModel(tx, eq(aiModel.id, input.id), 'share')
  assertProvider(source, capabilities)
  const sourceFault = assertAdminFaultConfig(source, capabilities)
  const paramsSchema = parseAdminParamsSchema(source.kind, input.paramsSchema)
  const copiedFault = assertAdminFaultConfig(
    { ...source, key: input.key, paramsSchema },
    capabilities,
  )
  // 同时删除前缀与扩展会各自成为合法普通模型，因此还需保护来源故障属性。
  if (sourceFault && !copiedFault) {
    throw new AppError(
      'ACCEPTANCE_FAULT_INVALID',
      'Acceptance fault copies must retain fault model configuration.',
      { status: 400 },
    )
  }
  const values = modelValues({
    ...source,
    key: input.key,
    paramsSchema,
    tags: source.minPlanFeatures,
    enabled: false,
  })
  const [saved] = await tx
    .insert(aiModel)
    .values({ ...values, paramsSchema })
    .returning()
  if (!saved) throw modelNotFound()
  const hashes = await paramsSchemaHashes(source, saved)
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
      supportsTools: saved.supportsTools,
      paramsSchema: hashes,
      changes: {
        ...modelChanges(undefined, saved),
        paramsSchema: { before: null, after: hashes.after },
      },
    },
  })
  return saved.id
}
