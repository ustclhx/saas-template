/**
 * add-deploy-autoprovision 1.1：部署资源解析的纯逻辑，不读文件、不访问网络。
 * 读取 web / jobs 的 wrangler 配置对象，列出目标环境需要的 KV、R2、队列与 Hyperdrive，
 * 再把解析出的 ID 写回配置副本，生成部署配置（design 决策 2–4、7）。
 */

/** 生成器占位格式：24 个 0 加 8 位十六进制序号（scripts/create-project.mjs 的 postprocessProject）。 */
export const PLACEHOLDER_ID = /^0{24}[0-9a-f]{8}$/

/** 缺少 ID 或为生成器占位值时视为占位，其余值一律视为已固定（design 决策 3）。 */
export function isPlaceholderId(id) {
  return id === undefined || id === null || id === '' || PLACEHOLDER_ID.test(String(id))
}

/** 需要按 ID 绑定、web 与 jobs 同名共享的资源种类。 */
export const ID_KINDS = ['kv', 'hyperdrive']
/** 按名称绑定的资源种类，配置里写的名字就是约定名称。 */
export const NAMED_KINDS = ['r2', 'queue']
/** 创建顺序：KV → R2 → 死信队列 → 其他队列 → Hyperdrive（design 决策 6）。 */
export const CREATE_ORDER = ['kv', 'r2', 'dlq', 'queue', 'hyperdrive']

/** 为空时在 plan 中列为缺项的 vars（design 决策 7），只提示不失败。 */
export const PROJECT_VARS = ['APP_URL', 'AI_GATEWAY_ID', 'TURNSTILE_SITE_KEY']
/** 为空时用 CLOUDFLARE_ACCOUNT_ID 补齐的账号 vars，已有值不覆盖。 */
export const ACCOUNT_VARS = ['R2_ACCOUNT_ID', 'AI_GATEWAY_ACCOUNT_ID']

export class ResourceConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ResourceConfigError'
  }
}

/** 读取某个环境的配置段；目标环境不存在时报错，避免静默解析顶层（本地开发）配置。 */
export function envSection(config, environment) {
  const section = config?.env?.[environment]
  if (!section) throw new ResourceConfigError(`env.${environment} 不存在`)
  return section
}

/**
 * 由 web Worker 名推出前缀与后缀：`acme-web-staging` → `acme-` / `-staging`。
 * 取最后一个 `web`，项目名本身含 `web` 时（如 `acme-web-web-staging`）也成立。
 */
export function namingFromWorker(workerName) {
  const name = String(workerName ?? '')
  const at = name.lastIndexOf('web')
  const prefix = at < 0 ? '' : name.slice(0, at)
  const suffix = at < 0 ? '' : name.slice(at + 3)
  if (at < 0 || (prefix && !prefix.endsWith('-')) || (suffix && !suffix.startsWith('-')))
    throw new ResourceConfigError(
      `无法从 web Worker 名 "${name}" 推出资源前缀与后缀（期望形如 <前缀>web<后缀>，如 acme-web-staging）`,
    )
  return { prefix, suffix }
}

/** 约定名称：`<前缀><绑定名小写，_ 换成 -><后缀>`，CACHE → cache、HYPERDRIVE_CACHED → hyperdrive-cached。 */
export function conventionalName(binding, naming) {
  return `${naming.prefix}${String(binding).toLowerCase().replaceAll('_', '-')}${naming.suffix}`
}

/** 遍历一个环境中的全部资源引用，不写死绑定名；插件或项目新增的绑定同样覆盖。 */
function* references(app, section) {
  for (const [index, item] of (section.kv_namespaces ?? []).entries())
    yield { kind: 'kv', app, binding: item.binding, id: item.id, path: ['kv_namespaces', index] }
  for (const [index, item] of (section.hyperdrive ?? []).entries())
    yield {
      kind: 'hyperdrive',
      app,
      binding: item.binding,
      id: item.id,
      path: ['hyperdrive', index],
    }
  for (const item of section.r2_buckets ?? [])
    yield { kind: 'r2', app, binding: item.binding, name: item.bucket_name }
  for (const item of section.queues?.producers ?? [])
    yield { kind: 'queue', app, binding: item.binding, name: item.queue }
  for (const item of section.queues?.consumers ?? []) {
    yield { kind: 'queue', app, binding: 'consumer', name: item.queue }
    if (item.dead_letter_queue)
      yield { kind: 'queue', app, binding: 'dead_letter_queue', name: item.dead_letter_queue }
  }
}

/**
 * 列出目标环境需要解析的资源，按「环境 + 绑定名」合并 web 与 jobs（KV / Hyperdrive），
 * 按名称合并 R2 桶与队列。返回 `{ naming, resources, pinned }`：
 * - 资源 `source` 为 `fixed`（已固定 ID）或 `unresolved`（占位，需按约定名称解析）；
 *   R2 / 队列没有 ID，`source` 为 `named`。
 * - `pinned` 表示全部 ID 类绑定都已固定：沿用已有项目的行为，R2 / 队列视为已存在，不调用 API。
 * 两边已固定的 ID 不同属配置错误，直接抛出。
 */
export function collectResources(configs, environment) {
  const web = envSection(configs.web, environment)
  const naming = namingFromWorker(web.name)
  const byKey = new Map()
  for (const app of Object.keys(configs)) {
    const section = envSection(configs[app], environment)
    for (const ref of references(app, section)) {
      if (!ref.binding && ref.kind !== 'queue')
        throw new ResourceConfigError(`${app} env.${environment} 有缺少 binding 的 ${ref.kind}`)
      if (NAMED_KINDS.includes(ref.kind) && !ref.name)
        throw new ResourceConfigError(
          `${app} env.${environment} 的 ${ref.kind} ${ref.binding} 缺少名称`,
        )
      const key = ID_KINDS.includes(ref.kind)
        ? `${ref.kind}:${ref.binding}`
        : `${ref.kind}:${ref.name}`
      let resource = byKey.get(key)
      if (!resource) {
        resource = ID_KINDS.includes(ref.kind)
          ? {
              key,
              kind: ref.kind,
              binding: ref.binding,
              name: conventionalName(ref.binding, naming),
              id: null,
              source: 'unresolved',
              apps: [],
              refs: [],
            }
          : {
              key,
              kind: ref.kind,
              name: ref.name,
              bindings: [],
              deadLetter: false,
              source: 'named',
              apps: [],
            }
        byKey.set(key, resource)
      }
      if (!resource.apps.includes(app)) resource.apps.push(app)
      if (ID_KINDS.includes(ref.kind)) {
        resource.refs.push({ app, path: ref.path })
        if (!isPlaceholderId(ref.id)) {
          if (resource.id && resource.id !== ref.id)
            throw new ResourceConfigError(
              `env.${environment} 的 ${ref.kind} ${ref.binding} 在各 app 中固定了不同的 ID（${resource.id} / ${ref.id}），web 与 jobs 必须共享同一资源`,
            )
          resource.id = ref.id
          resource.source = 'fixed'
        }
      } else {
        if (ref.binding === 'dead_letter_queue') resource.deadLetter = true
        if (!resource.bindings.includes(ref.binding)) resource.bindings.push(ref.binding)
      }
    }
  }
  const resources = [...byKey.values()].sort(
    (a, b) => CREATE_ORDER.indexOf(stage(a)) - CREATE_ORDER.indexOf(stage(b)),
  )
  const pinned = resources.every((item) => !ID_KINDS.includes(item.kind) || item.source === 'fixed')
  return { naming, resources, pinned }
}

/** 资源在创建顺序中的阶段：被引用为 dead_letter_queue 的队列先于其他队列。 */
export function stage(resource) {
  return resource.kind === 'queue' && resource.deadLetter ? 'dlq' : resource.kind
}

/** 限流 namespace_id 在同一项目各环境、各绑定间必须互不相同（design 决策 7）。 */
export function rateLimitConflicts(configs) {
  const problems = []
  const owners = new Map()
  for (const [app, config] of Object.entries(configs)) {
    const sections = [
      ['top-level', config],
      ...Object.entries(config?.env ?? {}).map(([name, section]) => [`env.${name}`, section]),
    ]
    for (const [where, section] of sections)
      for (const item of section?.ratelimits ?? []) {
        const owner = owners.get(item.namespace_id)
        const label = `${app} ${where} ${item.name}`
        if (owner)
          problems.push(`限流 namespace_id ${item.namespace_id} 同时用于 ${owner} 与 ${label}`)
        else owners.set(item.namespace_id, label)
      }
  }
  return problems
}

/** 目标环境中为空、需由项目填写的 vars，plan 中列为缺项。 */
export function missingProjectVars(configs, environment) {
  const missing = []
  for (const [app, config] of Object.entries(configs)) {
    const vars = envSection(config, environment).vars ?? {}
    for (const key of PROJECT_VARS)
      if (Object.hasOwn(vars, key) && vars[key] === '') missing.push(`${app} vars.${key}`)
  }
  return missing
}

/**
 * 把解析结果写入完整配置对象的副本：保留 env 结构与其他字段，只改目标环境的 ID，
 * 账号 vars 只在值为空时用 accountId 补齐。`ids` 为 `Map<resource.key, id>`。
 */
export function applyResolution(config, app, environment, resources, { accountId } = {}) {
  const result = structuredClone(config)
  const section = envSection(result, environment)
  for (const resource of resources) {
    if (!ID_KINDS.includes(resource.kind)) continue
    if (!resource.id)
      throw new ResourceConfigError(`${resource.kind} ${resource.binding} 尚未解析出 ID`)
    for (const ref of resource.refs) {
      if (ref.app !== app) continue
      const [field, index] = ref.path
      section[field][index].id = resource.id
    }
  }
  if (accountId && section.vars)
    for (const key of ACCOUNT_VARS)
      if (Object.hasOwn(section.vars, key) && section.vars[key] === '')
        section.vars[key] = accountId
  return result
}
