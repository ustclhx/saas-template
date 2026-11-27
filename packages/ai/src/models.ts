import type { PricingMode } from '@saas/config'
import { type AiModel, aiModel, type Database, type NewAiModel } from '@saas/db'
import { can, type Entitlements, requireEntitlement } from '@saas/entitlements'
import { AppError } from '@saas/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { MAX_MODEL_FALLBACKS, type ModelFallback } from './failover/fallbacks.ts'
import { ACCEPTANCE_FAULT_INVALID, type FaultAccessContext, parseAcceptanceFault } from './fault.ts'
import { type MediaProperty, type MediaSchema, parseMediaSchema } from './media/params.ts'
import { type AiModality, type Pricing, PricingError, parsePricing } from './pricing.ts'

/**
 * 模型注册表的读取（docs/06-ai.md §2，specs/ai-model-registry「模型可见性」）。
 *
 * - 列表（展示与选择）：只含已启用的模型，经 KV 缓存；后台保存后调用 `invalidateModelCache`。
 * - 调用前取模型（`requireAvailableModel`）：直接读库、不走缓存，停用后立即拒绝，
 *   返回的 `pricing` 即发起调用时应写入的定价快照。
 */

/** 校验过计费方式的已启用模型 */
export interface AvailableModel {
  readonly id: string
  readonly key: string
  readonly displayName?: string | null
  readonly kind: AiModality
  readonly provider: string
  readonly providerModelId: string
  readonly pricing: Pricing
  /** 与 `plan.features.models` 匹配的标签（`ai_model.min_plan_features`） */
  readonly tags: readonly string[]
  readonly paramsSchema: Record<string, unknown> | null
  readonly sort: number
  /** 有序备用模型（add-media-provider-fallback D2）；只供服务端切换，不影响可见性与价格。 */
  readonly fallbacks: readonly ModelFallback[]
}

/** 读取模型的来源，生产中为数据库（`dbModelStore`），测试中可替换 */
export interface ModelStore {
  /** 全部已启用模型，按 sort 排序 */
  listEnabled(): Promise<AiModel[]>
  /** 按 id 取已启用模型；不存在或已停用返回 `undefined` */
  findEnabled(id: string): Promise<AiModel | undefined>
  /** 按 key 取模型（不论是否启用），供备用链解析；顺序不限 */
  findByKeys(keys: readonly string[]): Promise<AiModel[]>
}

/** 模型列表缓存，生产中由 KV 实现（`KVNamespace` 结构兼容） */
export interface ModelCache {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface ModelRegistryContext {
  store: ModelStore
  cache?: ModelCache | undefined
  /** 目标未装配 Workers AI 时显式传 false；省略保留既有调用方行为。 */
  workersAi?: boolean | undefined
  faultAccess?: FaultAccessContext | undefined
}

export interface ModelAvailabilityOptions {
  readonly kind?: AiModality
  readonly requiresTools?: boolean
}

export const MODEL_CACHE_KEY = 'ai:models'
/** KV 允许的最小 TTL；后台保存时主动失效，TTL 只兜底其他地域的旧副本 */
export const MODEL_CACHE_TTL_SECONDS = 60

export const MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE'

const providerAvailable = (ctx: Pick<ModelRegistryContext, 'workersAi'>, provider: string) =>
  provider !== 'workers-ai' || ctx.workersAi !== false

function supportsToolCalls(model: Pick<AiModel, 'kind' | 'supportsTools'>): boolean {
  return model.kind === 'text' && model.supportsTools === true
}

export function dbModelStore(db: Database): ModelStore {
  return {
    listEnabled: () =>
      db
        .select()
        .from(aiModel)
        .where(eq(aiModel.enabled, true))
        .orderBy(asc(aiModel.sort), asc(aiModel.key)),
    async findEnabled(id) {
      const rows = await db
        .select()
        .from(aiModel)
        .where(and(eq(aiModel.id, id), eq(aiModel.enabled, true)))
        .limit(1)
      return rows[0]
    },
    async findByKeys(keys) {
      if (keys.length === 0) return []
      return db
        .select()
        .from(aiModel)
        .where(inArray(aiModel.key, [...keys]))
    },
  }
}

/** 行 → 可用模型；计费方式不合法（如按次文本模型缺 token 上限）的行视为不可用 */
function toAvailable(row: AiModel): AvailableModel | undefined {
  let pricing: Pricing
  try {
    pricing = parsePricing(row.pricing, row.kind)
    parseAcceptanceFault(row)
  } catch (error) {
    if (error instanceof PricingError) return undefined
    if (error instanceof AppError && error.code === ACCEPTANCE_FAULT_INVALID) return undefined
    throw error
  }
  return {
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    kind: row.kind,
    provider: row.provider,
    providerModelId: row.providerModelId,
    pricing,
    tags: row.minPlanFeatures,
    paramsSchema: row.paramsSchema ?? null,
    sort: row.sort,
    fallbacks: row.fallbacks ?? [],
  }
}

function faultAvailable(
  ctx: Pick<ModelRegistryContext, 'faultAccess'>,
  model: AvailableModel,
): boolean {
  try {
    return (
      parseAcceptanceFault(model) === undefined ||
      (ctx.faultAccess?.enabled === true && ctx.faultAccess.platformAdmin === true)
    )
  } catch (error) {
    if (error instanceof AppError && error.code === ACCEPTANCE_FAULT_INVALID) return false
    throw error
  }
}

/** 当前目标可用的已启用模型（不按权益过滤） */
export async function listEnabledModels(
  ctx: ModelRegistryContext,
  { requiresTools }: Pick<ModelAvailabilityOptions, 'requiresTools'> = {},
): Promise<AvailableModel[]> {
  // KV 跨地域生效有延迟，Agent 的选模须在下一次请求反映标记变更。
  const cache = requiresTools ? undefined : ctx.cache
  const cached = await cache?.get(MODEL_CACHE_KEY)
  if (cached != null)
    return (
      (JSON.parse(cached) as AvailableModel[])
        .filter((model) => providerAvailable(ctx, model.provider) && faultAvailable(ctx, model))
        // 升级前写入的缓存没有 fallbacks 字段，60 秒 TTL 内按空链处理。
        .map((model) => ({ ...model, fallbacks: model.fallbacks ?? [] }))
    )
  const models = (await ctx.store.listEnabled()).flatMap((row) => {
    if (requiresTools && !supportsToolCalls(row)) return []
    return toAvailable(row) ?? []
  })
  await cache?.put(MODEL_CACHE_KEY, JSON.stringify(models), {
    expirationTtl: MODEL_CACHE_TTL_SECONDS,
  })
  // 缓存保留完整注册表，每次读取后按目标、环境和身份过滤，避免共享缓存串权。
  return models.filter(
    (model) => providerAvailable(ctx, model.provider) && faultAvailable(ctx, model),
  )
}

const allowed = (entitlements: Entitlements, model: AvailableModel) =>
  can(entitlements, 'ai.useModel', { modelKey: model.key, tags: model.tags })

/** 空间当前权益允许且已启用的模型，供模型选择器展示 */
export async function listAvailableModels(
  ctx: ModelRegistryContext,
  entitlements: Entitlements,
  options: ModelAvailabilityOptions = {},
): Promise<(AvailableModel & { readonly displayName: string })[]> {
  const models = await listEnabledModels(ctx, options)
  return models
    .filter(
      (model) =>
        (options.kind === undefined || model.kind === options.kind) && allowed(entitlements, model),
    )
    .map((model) => ({ ...model, displayName: model.displayName ?? model.key }))
}

/**
 * 发起调用前按 id 取模型：不存在、已停用、不符合类型或能力要求、目标能力缺失或计费方式不合法时抛出 `MODEL_UNAVAILABLE`（404），
 * 权益不允许时抛出 `UPGRADE_REQUIRED`（403）。直接读库，不受列表缓存延迟影响。
 */
export async function requireAvailableModel(
  ctx: Pick<ModelRegistryContext, 'store' | 'workersAi' | 'faultAccess'>,
  entitlements: Entitlements,
  id: string,
  { kind, requiresTools }: ModelAvailabilityOptions = {},
): Promise<AvailableModel> {
  const row = await ctx.store.findEnabled(id)
  const model =
    row &&
    (kind === undefined || row.kind === kind) &&
    (!requiresTools || supportsToolCalls(row)) &&
    toAvailable(row)
  if (!model || !faultAvailable(ctx, model))
    throw new AppError(MODEL_UNAVAILABLE, 'Model is not available', { status: 404 })
  if (!providerAvailable(ctx, model.provider))
    throw new AppError(MODEL_UNAVAILABLE, 'Workers AI is not available on this runtime', {
      status: 404,
    })
  requireEntitlement(entitlements, {
    capability: 'ai.useModel',
    modelKey: model.key,
    tags: model.tags,
  })
  return model
}

/** 后台保存模型后调用，使列表缓存立即失效 */
export async function invalidateModelCache(cache: ModelCache | undefined): Promise<void> {
  await cache?.delete(MODEL_CACHE_KEY)
}

/**
 * 新建模型时预填的计费方式（specs/ai-model-registry「新模型的默认计费方式」）：
 * 方式取模板配置 `ai.defaultPricingMode[kind]`，数值为占位，由管理员填写。
 * 按次文本模型不预填 token 上限，管理员必须显式填写才能保存。
 */
export function defaultPricing(
  kind: AiModality,
  modes: { readonly [M in AiModality]: PricingMode },
): Pricing {
  switch (modes[kind]) {
    case 'per_call':
      return { mode: 'per_call', credits: 1, chargeOn: kind === 'text' ? 'any_output' : 'success' }
    case 'token':
      return { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 }
    case 'per_unit':
      return { mode: 'per_unit', unit: kind === 'video' ? 'second' : 'image', perUnit: 1 }
  }
}

/** 后台保存模型时提交的字段 */
export interface ModelInput {
  readonly key: string
  readonly kind: AiModality
  readonly provider: string
  readonly providerModelId: string
  readonly pricing: unknown
  readonly tags: readonly string[]
  readonly enabled: boolean
  readonly supportsTools?: boolean | undefined
  readonly sort: number
  readonly paramsSchema?: Record<string, unknown> | null | undefined
}

/**
 * 校验后台提交的模型并返回要写入 `ai_model` 的字段。计费方式经 `parsePricing` 校验，
 * 不合法时抛出 `PricingError`（如按次文本模型缺 token 上限：`MISSING_TOKEN_LIMITS`），保存被拒绝。
 */
export function modelValues(input: ModelInput) {
  const pricing = parsePricing(input.pricing, input.kind)
  parseAcceptanceFault({
    ...input,
    key: input.key.trim(),
    provider: input.provider.trim(),
    providerModelId: input.providerModelId.trim(),
  })
  return {
    key: input.key.trim(),
    kind: input.kind,
    provider: input.provider.trim(),
    providerModelId: input.providerModelId.trim(),
    pricing,
    minPlanFeatures: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    enabled: input.enabled,
    supportsTools: input.kind === 'text' ? input.supportsTools : false,
    sort: input.sort,
  } satisfies Partial<NewAiModel>
}

// ---------------------------------------------------------------------------
// 备用模型链（add-media-provider-fallback 决策 D2，specs/ai-model-registry「备用模型配置」）
// ---------------------------------------------------------------------------

export const MODEL_FALLBACK_INVALID = 'MODEL_FALLBACK_INVALID'

/** 保存校验所需的模型字段；后台与 Admin MCP 传入数据库行即可。 */
export type FallbackModelRef = Pick<
  AiModel,
  'key' | 'kind' | 'provider' | 'supportsTools' | 'paramsSchema'
>

const fallbackShape = z
  .array(
    z
      .object({
        modelKey: z.string().trim().min(1),
        paramMap: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
      })
      .strict(),
  )
  .max(MAX_MODEL_FALLBACKS)

function fallbackError(message: string, details: Record<string, unknown> = {}) {
  // 信息只含模型 key 与字段名，可原样展示给管理员。
  return new AppError(MODEL_FALLBACK_INVALID, message, {
    status: 400,
    details,
    publicDetails: details,
  })
}

/** 校验备用链的 JSON 形态（≤ MAX_MODEL_FALLBACKS、key 非空、paramMap 为字符串映射），去掉空映射。 */
export function parseModelFallbacks(value: unknown): ModelFallback[] {
  if (Array.isArray(value) && value.length > MAX_MODEL_FALLBACKS)
    throw fallbackError(`At most ${MAX_MODEL_FALLBACKS} fallback models are allowed`)
  const parsed = fallbackShape.safeParse(value ?? [])
  if (!parsed.success)
    throw fallbackError('Fallback models must be a list of { modelKey, paramMap }')
  return parsed.data.map(({ modelKey, paramMap }) =>
    paramMap && Object.keys(paramMap).length > 0 ? { modelKey, paramMap } : { modelKey },
  )
}

/** 按备用的 paramMap 把主模型参数改名；未列出的字段同名透传。 */
export function mapFallbackParams<T>(
  params: Readonly<Record<string, T>>,
  paramMap: Readonly<Record<string, string>> | undefined,
): Record<string, T> {
  if (!paramMap) return { ...params }
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [paramMap[name] ?? name, value]),
  )
}

const emptyMediaSchema: MediaSchema = { type: 'object', properties: {}, required: [] }

function mediaSchemaOf(model: FallbackModelRef): MediaSchema {
  if (model.paramsSchema === null) return emptyMediaSchema
  try {
    return parseMediaSchema(model.paramsSchema)
  } catch {
    throw fallbackError(`Model ${model.key} has an unsupported parameter schema`, {
      modelKey: model.key,
    })
  }
}

const defaultUnitsParam = (kind: 'image' | 'video') =>
  kind === 'image' ? 'num_images' : 'duration'

/** 字段可取值的数值下界与上界；枚举按取值计算，exclusive 视为同值的开区间。 */
function numericBounds(field: MediaProperty) {
  const values = field.enum?.filter((value): value is number => typeof value === 'number')
  if (values?.length)
    return {
      min: { value: Math.min(...values), exclusive: false },
      max: { value: Math.max(...values), exclusive: false },
    }
  const min =
    field.exclusiveMinimum !== undefined
      ? { value: field.exclusiveMinimum, exclusive: true }
      : field.minimum !== undefined
        ? { value: field.minimum, exclusive: false }
        : undefined
  const max =
    field.exclusiveMaximum !== undefined
      ? { value: field.exclusiveMaximum, exclusive: true }
      : field.maximum !== undefined
        ? { value: field.maximum, exclusive: false }
        : undefined
  return { min, max }
}

type Bound = { value: number; exclusive: boolean } | undefined

/** 备用下界覆盖主模型下界：备用无下界，或主模型下界不低于备用下界。 */
function lowerCovered(primary: Bound, fallback: Bound): boolean {
  if (!fallback) return true
  if (!primary) return false
  if (primary.value !== fallback.value) return primary.value > fallback.value
  return primary.exclusive || !fallback.exclusive
}

function upperCovered(primary: Bound, fallback: Bound): boolean {
  if (!fallback) return true
  if (!primary) return false
  if (primary.value !== fallback.value) return primary.value < fallback.value
  return primary.exclusive || !fallback.exclusive
}

/** 返回主字段经映射后不能被备用字段接受的原因；兼容时返回 undefined。 */
function fieldIncompatibility(primary: MediaProperty, fallback: MediaProperty): string | undefined {
  const typeOk =
    primary.type === fallback.type || (primary.type === 'integer' && fallback.type === 'number')
  if (!typeOk) return `type ${primary.type} is not accepted as ${fallback.type}`
  if ((primary.format ?? null) !== (fallback.format ?? null)) return 'format differs'
  if (fallback.enum) {
    if (!primary.enum) return 'fallback only accepts a fixed set of values'
    const missing = primary.enum.filter((value) => !fallback.enum?.includes(value))
    if (missing.length) return `values ${missing.map(String).join(', ')} are not accepted`
  }
  if (primary.type === 'number' || primary.type === 'integer') {
    const p = numericBounds(primary)
    const f = numericBounds(fallback)
    if (!lowerCovered(p.min, f.min) || !upperCovered(p.max, f.max))
      return 'numeric range is not covered by the fallback'
    if (
      fallback.multipleOf !== undefined &&
      (primary.multipleOf === undefined ||
        !Number.isInteger(primary.multipleOf / fallback.multipleOf)) &&
      !primary.enum?.every((value) => Number.isInteger(Number(value) / (fallback.multipleOf ?? 1)))
    )
      return 'multipleOf is not compatible'
  }
  if (primary.type === 'string') {
    if (
      fallback.maxLength !== undefined &&
      (primary.maxLength === undefined || primary.maxLength > fallback.maxLength) &&
      !primary.enum?.every((value) => String(value).length <= (fallback.maxLength ?? 0))
    )
      return 'maxLength is not covered by the fallback'
    if (
      fallback.minLength !== undefined &&
      (primary.minLength ?? 0) < fallback.minLength &&
      !primary.enum?.every((value) => String(value).length >= (fallback.minLength ?? 0))
    )
      return 'minLength is not covered by the fallback'
    if (fallback.pattern !== undefined && fallback.pattern !== primary.pattern && !primary.enum)
      return 'pattern differs'
  }
  return undefined
}

/** 媒体模型：主 schema 每个字段经 paramMap 映射后都必须被备用 schema 接受。 */
function assertMediaParamsCompatible(
  primary: FallbackModelRef & { kind: 'image' | 'video' },
  fallback: FallbackModelRef,
  paramMap: Readonly<Record<string, string>> | undefined,
) {
  const primarySchema = mediaSchemaOf(primary)
  const fallbackSchema = mediaSchemaOf(fallback)
  const fail = (field: string, reason: string) =>
    fallbackError(`Fallback ${fallback.key} is incompatible on parameter ${field}: ${reason}`, {
      modelKey: fallback.key,
      field,
    })
  const targets = new Map<string, string>()
  for (const source of Object.keys(paramMap ?? {}))
    if (!Object.hasOwn(primarySchema.properties, source))
      throw fail(source, 'not a parameter of the primary model')
  for (const [name, field] of Object.entries(primarySchema.properties)) {
    const target = paramMap?.[name] ?? name
    const other = targets.get(target)
    if (other !== undefined) throw fail(name, `maps to ${target} together with ${other}`)
    targets.set(target, name)
    const fallbackField = fallbackSchema.properties[target]
    if (!fallbackField) throw fail(name, `fallback has no parameter ${target}`)
    const reason = fieldIncompatibility(field, fallbackField)
    if (reason) throw fail(name, reason)
  }
  // 备用必填但主模型可能不提供的字段：提交时会被备用拒绝。
  const primaryRequired = new Set(primarySchema.required)
  for (const required of fallbackSchema.required) {
    const source = targets.get(required)
    if (
      source === undefined ||
      (!primaryRequired.has(source) && primarySchema.properties[source]?.default === undefined)
    )
      throw fail(source ?? required, `fallback requires ${required}`)
  }
  // 计量字段必须对应，否则备用按不同数量生成而用户按主模型数量结算。
  const primaryUnits = primarySchema['x-media']?.unitsParam ?? defaultUnitsParam(primary.kind)
  const fallbackUnits = fallbackSchema['x-media']?.unitsParam ?? defaultUnitsParam(primary.kind)
  const mappedUnits = Object.hasOwn(primarySchema.properties, primaryUnits)
    ? (paramMap?.[primaryUnits] ?? primaryUnits)
    : undefined
  if (Object.hasOwn(fallbackSchema.properties, fallbackUnits) && mappedUnits !== fallbackUnits)
    throw fail(primaryUnits, `units parameter must map to ${fallbackUnits}`)
}

/**
 * 校验备用链（后台与 Admin MCP 共用）：同类型、不含自身、服务商与主模型及彼此互不相同、
 * ≤ MAX_MODEL_FALLBACKS、引用的 key 已登记；媒体按 paramMap 映射后逐字段兼容；
 * 文本主模型支持工具调用时备用也必须支持。`models` 为按 key 取到的备用模型行。
 */
export function assertModelFallbacks(
  primary: FallbackModelRef,
  fallbacks: readonly ModelFallback[],
  models: ReadonlyMap<string, FallbackModelRef>,
): void {
  if (fallbacks.length > MAX_MODEL_FALLBACKS)
    throw fallbackError(`At most ${MAX_MODEL_FALLBACKS} fallback models are allowed`)
  const providers = new Set([primary.provider])
  for (const { modelKey, paramMap } of fallbacks) {
    if (modelKey === primary.key)
      throw fallbackError('A model cannot be its own fallback', { modelKey })
    const fallback = models.get(modelKey)
    if (!fallback) throw fallbackError(`Fallback model ${modelKey} does not exist`, { modelKey })
    if (fallback.kind !== primary.kind)
      throw fallbackError(`Fallback ${modelKey} must be a ${primary.kind} model`, { modelKey })
    if (providers.has(fallback.provider))
      throw fallbackError(
        `Fallback ${modelKey} must use a different provider than the primary model and other fallbacks`,
        { modelKey, provider: fallback.provider },
      )
    providers.add(fallback.provider)
    if (primary.kind === 'text') {
      if (paramMap && Object.keys(paramMap).length > 0)
        throw fallbackError('Parameter mapping is only supported for media models', { modelKey })
      if (primary.supportsTools && !fallback.supportsTools)
        throw fallbackError(`Fallback ${modelKey} does not support tool calls`, {
          modelKey,
          field: 'supportsTools',
        })
    } else {
      assertMediaParamsCompatible({ ...primary, kind: primary.kind }, fallback, paramMap)
    }
  }
}

type DatabaseOrTransaction = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * 保存前校验：解析形态、读取被引用的模型并调用 `assertModelFallbacks`，返回规范化后的链。
 * 在保存事务内调用，避免校验与写入之间被引用模型被删除。
 */
export async function validateModelFallbacks(
  db: DatabaseOrTransaction,
  primary: FallbackModelRef,
  value: unknown,
): Promise<ModelFallback[]> {
  const fallbacks = parseModelFallbacks(value)
  const keys = [...new Set(fallbacks.map(({ modelKey }) => modelKey))]
  const rows = keys.length
    ? await db
        .select({
          key: aiModel.key,
          kind: aiModel.kind,
          provider: aiModel.provider,
          supportsTools: aiModel.supportsTools,
          paramsSchema: aiModel.paramsSchema,
        })
        .from(aiModel)
        .where(inArray(aiModel.key, keys))
    : []
  assertModelFallbacks(primary, fallbacks, new Map(rows.map((row) => [row.key, row])))
  return fallbacks
}

/** 从所有引用 `key` 的备用链中移除它；须与删除模型在同一事务内执行。返回受影响的模型 key。 */
export async function removeModelFromFallbacks(
  db: DatabaseOrTransaction,
  key: string,
): Promise<string[]> {
  const rows = await db
    .update(aiModel)
    .set({
      fallbacks: sql`coalesce((select jsonb_agg(entry order by ordinality) from jsonb_array_elements(${aiModel.fallbacks}) with ordinality as item(entry, ordinality) where entry->>'modelKey' <> ${key}), '[]'::jsonb)`,
    })
    .where(sql`${aiModel.fallbacks} @> ${JSON.stringify([{ modelKey: key }])}::jsonb`)
    .returning({ key: aiModel.key })
  return rows.map((row) => row.key)
}

/**
 * 删除模型并在同一事务内从所有备用链中移除它（spec「删除被引用的备用模型」）。
 * 可传数据库或外层事务。
 */
export async function deleteModelByKey(
  db: DatabaseOrTransaction,
  key: string,
): Promise<{ deleted: boolean; detachedFrom: string[] }> {
  const run = async (tx: DatabaseOrTransaction) => {
    const detachedFrom = await removeModelFromFallbacks(tx, key)
    const deleted = await tx
      .delete(aiModel)
      .where(eq(aiModel.key, key))
      .returning({ id: aiModel.id })
    return { deleted: deleted.length > 0, detachedFrom }
  }
  // 外层已是事务时 drizzle 以 savepoint 嵌套，仍与外层一起提交或回滚。
  return (db as Database).transaction(run)
}

/** 备用链中的一个执行候选：带上该备用的参数改名映射（主模型为 undefined）。 */
export interface ModelCandidate extends AvailableModel {
  readonly paramMap?: Readonly<Record<string, string>> | undefined
}

/**
 * 运行时候选（供媒体切换与文本备用包装使用）：按顺序返回 `[主, ...备用]`。
 * 备用即使已停用或不在套餐可见列表中也返回（spec「备用模型不影响用户可见性与价格」）；
 * 已删除、类型不符或计费配置不合法的备用跳过。服务商是否已配置由调用方按运行环境判断。
 * 计费始终使用主模型（第一个候选）的 `pricing`。
 * `requiresTools`（agent）时再跳过当前不支持工具调用的备用：保存时已校验，但管理员之后可能关掉备用的工具标记。
 */
export async function resolveModelCandidates(
  ctx: Pick<ModelRegistryContext, 'store'>,
  primary: AvailableModel,
  { requiresTools }: Pick<ModelAvailabilityOptions, 'requiresTools'> = {},
): Promise<ModelCandidate[]> {
  const fallbacks = primary.fallbacks.slice(0, MAX_MODEL_FALLBACKS)
  if (fallbacks.length === 0) return [primary]
  const rows = await ctx.store.findByKeys(fallbacks.map(({ modelKey }) => modelKey))
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const candidates: ModelCandidate[] = [primary]
  for (const { modelKey, paramMap } of fallbacks) {
    const row = byKey.get(modelKey)
    if (!row || row.kind !== primary.kind || row.key === primary.key) continue
    if (requiresTools && !supportsToolCalls(row)) continue
    const model = toAvailable(row)
    if (!model || parseAcceptanceFault(model) !== undefined) continue
    candidates.push(paramMap ? { ...model, paramMap } : model)
  }
  return candidates
}
