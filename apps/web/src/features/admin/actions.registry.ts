import {
  aiModel,
  type Database,
  dbSettingStore,
  getSettingDefinition,
  validateSettingValue,
} from '@saas/db'
import { eq } from 'drizzle-orm'

/**
 * 后台动作登记表（openspec add-admin-step-up design.md 决策 1、「入口清单」）。
 *
 * 每个后台写入口（adminAction / withAdminAction / runAdminAction / 委托型包装 /
 * Better Auth 原生管理员入口 / 插件入口）都用这里登记的动作名调用包装，并据此判定是否需要
 * 重新验证（step-up）：
 * - `'always'`：始终敏感；`'never'`：日常操作，从不要求重新验证；
 * - 函数：按已通过 zod 校验的输入判定，调用方以 `{ name, input }` 传入输入。
 *
 * 模板动作名构成 `AdminActionName` 的字面量联合，未登记的名称在类型检查阶段报错；
 * 插件用 `defineAdminActions()` 追加登记，返回带品牌的名称供包装使用，键重复在加载时抛错。
 * 本文件只依赖 @saas/db（判定函数读取设置与模型现值），不依赖 web 运行时，可被测试与插件导入。
 */

export interface StepUpRuleContext {
  readonly db: Database
}

export type StepUpRule<Input> =
  | 'always'
  | 'never'
  | ((input: Input, ctx: StepUpRuleContext) => boolean | Promise<boolean>)

export interface AdminActionDefinition<Input = never> {
  readonly stepUp: StepUpRule<Input>
  /** 判定理由，供审阅与文档引用 */
  readonly reason: string
}

/** 按 key 递归排序后序列化，比较 JSON 值时不受键顺序影响 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  )
}

export interface SettingUpdateStepUpInput {
  /** 本次写入的设置项（键、未校验的新值） */
  readonly entries: readonly (readonly [key: string, value: unknown])[]
}

/**
 * 只有改动了 `secret: true` 的设置项才敏感；与数据库现值相同（表单原样提交）不算改动。
 * 未登记的键或不合法的值不在此判定：写入时会以 UNKNOWN_SETTING / INVALID_SETTING_VALUE 拒绝。
 */
export async function secretSettingChanged(
  input: SettingUpdateStepUpInput,
  { db }: StepUpRuleContext,
): Promise<boolean> {
  const store = dbSettingStore(db)
  for (const [key, value] of input.entries) {
    const definition = getSettingDefinition(key)
    if (!definition?.secret) continue
    let next: unknown
    try {
      next = validateSettingValue(key, value)
    } catch {
      continue
    }
    const stored = await store.find(key)
    const current = stored === undefined ? definition.default : stored
    if (canonicalJson(current) !== canonicalJson(next)) return true
  }
  return false
}

export interface ModelSaveStepUpInput {
  /** 后台表单编辑时的模型 ID；与 key 都缺省表示新建 */
  readonly id?: string | undefined
  /** MCP 按 key 更新现有模型 */
  readonly key?: string | undefined
  /** 本次提交的定价；缺省表示不改定价 */
  readonly pricing?: unknown
}

/** 新建模型，或定价与现值不同（定价即价格）时敏感；找不到目标模型按新建处理。 */
export async function modelPricingChanged(
  input: ModelSaveStepUpInput,
  { db }: StepUpRuleContext,
): Promise<boolean> {
  const where =
    input.id !== undefined
      ? eq(aiModel.id, input.id)
      : input.key !== undefined
        ? eq(aiModel.key, input.key)
        : undefined
  if (!where) return true
  const [model] = await db.select({ pricing: aiModel.pricing }).from(aiModel).where(where)
  if (!model) return true
  if (input.pricing === undefined) return false
  return canonicalJson(model.pricing) !== canonicalJson(input.pricing)
}

export interface RefundReviewStepUpInput {
  readonly decision: 'approve' | 'reject'
}

/** 模板内置的后台动作（2026-11-25 逐个核对的入口清单）。 */
export const adminActions = {
  'user.ban': { stepUp: 'always', reason: '影响他人访问' },
  'user.unban': { stepUp: 'always', reason: '影响他人访问' },
  'user.impersonate': { stepUp: 'always', reason: '取得他人身份' },
  'user.impersonate.stop': {
    stepUp: 'never',
    reason: '降权动作，且此时只有模拟会话、没有管理员会话',
  },
  'credits.adjust': { stepUp: 'always', reason: '积分是资金等价物' },
  'billing.webhook_replay': { stepUp: 'always', reason: '重放可能发放付款积分' },
  'billing.refund_review': {
    stepUp: (input: RefundReviewStepUpInput) => input.decision === 'approve',
    reason: '通过即资金流出；驳回不产生资金变动',
  },
  'billing.refund_manual': { stepUp: 'always', reason: '登记线下退款并收回积分' },
  'billing.refund_email_retry': { stepUp: 'never', reason: '只重发通知' },
  'setting.operations.update': { stepUp: 'always', reason: '运营通知设置全部为密钥' },
  'setting.update': {
    stepUp: secretSettingChanged,
    reason: '只有改动密钥类设置时敏感，普通设置属日常',
  },
  'ai.model_save': {
    stepUp: modelPricingChanged,
    reason: '新建模型或定价变化时敏感，定价即价格',
  },
  'ai.model_toggle': { stepUp: 'never', reason: '启停可逆' },
  'ai.model_copy': { stepUp: 'never', reason: '复制件默认停用' },
  'admin.plan.models.update': { stepUp: 'always', reason: '套餐权益变更' },
  'workspace.restore': { stepUp: 'never', reason: '只恢复原 owner，30 天内可逆' },
  'waitlist.invite': { stepUp: 'never', reason: '只发邀请' },
  'ai.feedback.delete': { stepUp: 'never', reason: '日常运营' },
  'ai.feedback.view': { stepUp: 'never', reason: '日常运营（读取共享对话并写审计）' },
  'observability.sentry_test': { stepUp: 'never', reason: '只抛测试异常' },
  'admin.confirmation.confirm': { stepUp: 'always', reason: '执行 AI 发起的敏感操作' },
  'admin.confirmation.reject': { stepUp: 'never', reason: '拒绝不产生副作用' },
} as const satisfies Record<string, AdminActionDefinition<never>>

type TemplateActions = typeof adminActions
export type TemplateAdminActionName = keyof TemplateActions

declare const pluginActionBrand: unique symbol
/** 插件经 `defineAdminActions()` 登记后得到的动作名；普通字符串不能冒充 */
export type PluginAdminActionName = string & { readonly [pluginActionBrand]: true }

export type AdminActionName = TemplateAdminActionName | PluginAdminActionName

type ConditionalActionName = {
  [N in TemplateAdminActionName]: TemplateActions[N]['stepUp'] extends string ? never : N
}[TemplateAdminActionName]

export type StepUpInput<N extends ConditionalActionName> = TemplateActions[N]['stepUp'] extends (
  input: infer Input,
  ...rest: never[]
) => unknown
  ? Input
  : never

/**
 * 包装接受的动作引用：始终 / 从不敏感的动作直接写名称；按输入判定的动作必须带上输入，
 * 否则类型检查失败（运行时缺少输入按敏感处理）。
 */
export type AdminActionRef =
  | Exclude<TemplateAdminActionName, ConditionalActionName>
  | {
      [N in ConditionalActionName]: { readonly name: N; readonly input: StepUpInput<N> }
    }[ConditionalActionName]
  | PluginAdminActionName
  | { readonly name: PluginAdminActionName; readonly input: unknown }

// biome-ignore lint/suspicious/noExplicitAny: 登记表的判定函数各自声明输入类型，查表时按 unknown 处理。
type AnyAdminActionDefinition = AdminActionDefinition<any>

const TEMPLATE_OWNER = 'template'
const registry = new Map<string, AnyAdminActionDefinition>(Object.entries(adminActions))
const owners = new Map<string, string>(
  Object.keys(adminActions).map((name) => [name, TEMPLATE_OWNER]),
)

/**
 * 插件追加登记动作（如 admin-mcp），`owner` 为插件 ID。整批校验后登记：键与模板或其他插件
 * 重复即抛错；同一插件重新加载模块（开发时热更新）时覆盖自己的登记。
 * 返回值的每个属性就是可传给包装的动作名：`runAdminAction(ctx, actions['x.y'], ...)`。
 */
export function defineAdminActions<const Group extends Record<string, AnyAdminActionDefinition>>(
  owner: string,
  group: Group,
): { readonly [K in keyof Group]: K & PluginAdminActionName } {
  if (owner === TEMPLATE_OWNER) throw new Error(`Reserved admin action owner: ${owner}`)
  const entries = Object.entries(group)
  for (const [name] of entries) {
    const existing = owners.get(name)
    if (existing !== undefined && existing !== owner)
      throw new Error(`Duplicate admin action: ${name} (already registered by ${existing})`)
  }
  for (const [name, definition] of entries) {
    registry.set(name, definition)
    owners.set(name, owner)
  }
  return Object.fromEntries(entries.map(([name]) => [name, name])) as {
    readonly [K in keyof Group]: K & PluginAdminActionName
  }
}

export function getAdminActionDefinition(name: string): AnyAdminActionDefinition | undefined {
  return registry.get(name)
}

/** 当前已登记的全部动作名（模板 + 已加载的插件），供守卫测试遍历 */
export function listAdminActionNames(): readonly string[] {
  return [...registry.keys()]
}

export function resolveAdminActionRef(ref: AdminActionRef): {
  readonly name: string
  readonly input: unknown
  readonly hasInput: boolean
} {
  return typeof ref === 'string'
    ? { name: ref, input: undefined, hasInput: false }
    : { name: ref.name, input: ref.input, hasInput: true }
}

/**
 * 判定一次调用是否需要重新验证。未登记的名称在运行时也按错误处理（防止类型断言绕过）；
 * 按输入判定的动作没有传入输入时按敏感处理。
 */
export async function requiresStepUp(ref: AdminActionRef, ctx: StepUpRuleContext) {
  const { name, input, hasInput } = resolveAdminActionRef(ref)
  const definition = registry.get(name)
  if (!definition) throw new Error(`Unregistered admin action: ${name}`)
  if (definition.stepUp === 'always') return true
  if (definition.stepUp === 'never') return false
  if (!hasInput) return true
  return definition.stepUp(input, ctx)
}
