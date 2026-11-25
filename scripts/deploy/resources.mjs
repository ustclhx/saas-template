/**
 * add-deploy-autoprovision 1.4：`pnpm deploy:resources --env <env> [--apply] [--allow-production]
 * [--create-hyperdrive] [--verify]`。
 *
 * 读取已提交的 apps/{web,jobs}/wrangler.jsonc，按约定名称解析目标环境的 KV、R2、队列与 Hyperdrive，
 * 写出 apps/<app>/wrangler.deploy.json（已 gitignore）。默认只读（plan）；已固定 ID 不调用 API。
 * 模式与顺序见 openspec/changes/add-deploy-autoprovision/design.md 决策 3、6、7。
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from '../production/check-wrangler-envs.mjs'
import {
  CloudflareApiError,
  createCloudflareApi,
  originFromConnectionString,
  PERMISSIONS,
} from './cloudflare-api.mjs'
import {
  ACCOUNT_VARS,
  applyResolution,
  collectResources,
  ID_KINDS,
  missingProjectVars,
  ResourceConfigError,
  rateLimitConflicts,
} from './resources-lib.mjs'

export const APPS = ['web', 'jobs']
export const DEPLOY_CONFIG = 'wrangler.deploy.json'

const USAGE =
  '用法：pnpm deploy:resources --env <staging|production> [--apply] [--allow-production] [--create-hyperdrive] [--verify]'
const KIND_LABELS = { kv: 'KV', r2: 'R2', queue: '队列', hyperdrive: 'Hyperdrive' }
const STATUS_LABELS = {
  fixed: '已固定',
  pinned: '已固定（按配置名称，未调用 API）',
  found: '按名称找到',
  created: '已创建',
  missing: '待创建',
  'cannot-create': '不能自动创建',
  'no-credentials': '待查找（缺少凭据）',
}

export function parseArgs(argv) {
  const options = {
    env: undefined,
    apply: false,
    allowProduction: false,
    createHyperdrive: false,
    verify: false,
  }
  const flags = {
    '--apply': 'apply',
    '--allow-production': 'allowProduction',
    '--create-hyperdrive': 'createHyperdrive',
    '--verify': 'verify',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--env') options.env = argv[++i]
    else if (arg.startsWith('--env=')) options.env = arg.slice('--env='.length)
    else if (flags[arg]) options[flags[arg]] = true
    else throw new ResourceConfigError(`未知参数 ${arg}\n${USAGE}`)
  }
  if (!options.env || options.env.startsWith('--'))
    throw new ResourceConfigError(`缺少 --env\n${USAGE}`)
  if (options.createHyperdrive && !options.apply)
    throw new ResourceConfigError('--create-hyperdrive 需要同时传 --apply')
  return options
}

function describe(resource) {
  const label = KIND_LABELS[resource.kind]
  const what = ID_KINDS.includes(resource.kind)
    ? `${label} ${resource.binding}`
    : `${label} ${resource.name}`
  return what
}

/** 终端显示宽度：中日韩字符占两列，用于对齐计划表。 */
const width = (text) =>
  [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
const pad = (text, size) => text + ' '.repeat(Math.max(0, size - width(text)))

function planLines(environment, mode, resources) {
  const rows = resources.map((item) => [
    describe(item),
    item.name,
    STATUS_LABELS[item.status] ?? item.status,
    item.id ?? '',
    item.apps.join(' + '),
  ])
  const header = ['绑定', '期望名称', '来源', 'ID', 'app']
  const widths = header.map((title, index) =>
    Math.max(width(title), ...rows.map((row) => width(row[index]))),
  )
  const line = (row) =>
    `  ${row
      .map((cell, index) => pad(cell, widths[index]))
      .join('  ')
      .trimEnd()}`
  return [`资源解析计划：env.${environment}（模式：${mode}）`, line(header), ...rows.map(line)]
}

/** 可直接粘贴回 wrangler.jsonc 的 ID 清单（回滚到手工填写时使用，design 迁移计划 3）。 */
function idList(environment, resources) {
  const lines = []
  for (const kind of ID_KINDS) {
    const items = resources.filter((item) => item.kind === kind)
    if (!items.length) continue
    const field = kind === 'kv' ? 'kv_namespaces' : 'hyperdrive'
    const entries = items.map((item) => `{ "binding": "${item.binding}", "id": "${item.id}" }`)
    lines.push(`  env.${environment}.${field}: [${entries.join(', ')}]`)
  }
  return lines
}

/**
 * 运行解析。依赖全部注入：`root` 为仓库根，`env` 为进程环境，`fetch` 为 HTTP 实现，
 * `log` / `error` 为输出。返回退出码：0 成功并写出部署配置，1 解析失败或仍有缺项，2 用法错误。
 */
export async function run({
  root,
  argv,
  env = {},
  fetch = globalThis.fetch,
  log = console.log,
  error = console.error,
}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (cause) {
    error(cause.message)
    return 2
  }
  const environment = options.env
  const isProduction = environment === 'production'
  const mayCreate = options.apply && (!isProduction || options.allowProduction)
  const mode = mayCreate ? 'apply' : options.apply ? 'plan（production 未开启创建）' : 'plan'

  // 先删除上一次生成的部署配置：本次失败时不留下可能过期的文件
  for (const app of APPS) rmSync(join(root, 'apps', app, DEPLOY_CONFIG), { force: true })

  let configs
  let collected
  try {
    configs = Object.fromEntries(
      APPS.map((app) => [
        app,
        parseJsonc(readFileSync(join(root, 'apps', app, 'wrangler.jsonc'), 'utf8')),
      ]),
    )
    collected = collectResources(configs, environment)
  } catch (cause) {
    error(`配置错误：${cause.message}`)
    return 1
  }
  const conflicts = rateLimitConflicts(configs)
  if (conflicts.length) {
    for (const line of conflicts) error(`配置错误：${line}`)
    error('限流 namespace_id 由项目分配，不由本命令生成；改成互不相同的值后重试。')
    return 1
  }
  const { resources, pinned } = collected
  for (const item of resources)
    item.status = item.source === 'fixed' ? 'fixed' : item.source === 'named' ? 'pinned' : 'missing'

  // 需要调用 API 的资源：占位的 ID 类绑定；环境未全部固定时的 R2 / 队列；--verify 时全部
  const lookup = resources.filter(
    (item) =>
      options.verify || item.source === 'unresolved' || (item.source === 'named' && !pinned),
  )
  const kinds = [...new Set(lookup.map((item) => item.kind))]
  const problems = []
  const warnings = []
  const created = []

  if (options.createHyperdrive && mayCreate) {
    if (!env.HYPERDRIVE_APP_URL) {
      error('--create-hyperdrive 需要在进程环境中提供 HYPERDRIVE_APP_URL（app 账号连接串）')
      return 1
    }
    try {
      originFromConnectionString(env.HYPERDRIVE_APP_URL)
    } catch (cause) {
      error(cause.message)
      return 1
    }
  }

  if (kinds.length && (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID)) {
    for (const item of lookup) if (item.status !== 'fixed') item.status = 'no-credentials'
    for (const line of planLines(environment, mode, resources)) log(line)
    const needed = kinds.flatMap((kind) => [
      PERMISSIONS[kind].list,
      ...(mayCreate && (kind !== 'hyperdrive' || options.createHyperdrive)
        ? [PERMISSIONS[kind].create]
        : []),
    ])
    error(
      [
        '缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID，无法查找上表中的资源。',
        `API 令牌需要的权限：${[...new Set(needed)].join('、')}。`,
        '只用 wrangler login 登录时，另在 Cloudflare 控制台创建带上述权限的 API 令牌，并以环境变量传入。',
      ].join('\n'),
    )
    return 1
  }

  let api
  const listings = new Map()
  const list = async (kind) => {
    const items = await api.list(kind)
    listings.set(kind, items)
    return items
  }
  try {
    if (kinds.length) {
      api = createCloudflareApi({
        token: env.CLOUDFLARE_API_TOKEN,
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        fetch,
      })
      for (const kind of kinds) await list(kind)
    }

    for (const item of lookup) {
      const listing = listings.get(item.kind)
      const matches = listing.filter((entry) => entry.name === item.name)
      if (item.source === 'fixed') {
        // --verify：只核对已固定 ID 存在，名称与约定不一致只提示
        const actual = listing.find((entry) => entry.id === item.id)
        if (!actual) problems.push(`${describe(item)} 的已固定 ID ${item.id} 在账号中不存在`)
        else if (actual.name !== item.name)
          warnings.push(
            `${describe(item)} 的实际名称 ${actual.name} 与约定名称 ${item.name} 不一致`,
          )
        continue
      }
      if (matches.length > 1) {
        problems.push(
          `${describe(item)}：名称 ${item.name} 对应多个资源（${matches.map((entry) => entry.id).join('、')}），请保留一个或在配置中固定 ID`,
        )
        item.status = 'conflict'
      } else if (matches.length === 1) {
        item.status = 'found'
        if (ID_KINDS.includes(item.kind)) item.id = matches[0].id
      } else {
        item.status =
          item.kind === 'hyperdrive' && !options.createHyperdrive ? 'cannot-create' : 'missing'
      }
    }
    if (problems.length) {
      for (const line of planLines(environment, mode, resources)) log(line)
      for (const line of warnings) log(`提示：${line}`)
      for (const line of problems) error(line)
      return 1
    }

    // 按 KV → R2 → 死信队列 → 其他队列 → Hyperdrive 依次创建（resources 已按此排序）
    if (mayCreate)
      for (const item of resources) {
        if (item.status !== 'missing') continue
        const cached = item.kind === 'hyperdrive' && /_CACHED$/.test(item.binding)
        await api.create(item.kind, item.name, {
          connectionString: env.HYPERDRIVE_APP_URL,
          cached,
        })
        // 重新查询确认，并以列表中的 ID 为准
        const matches = (await list(item.kind)).filter((entry) => entry.name === item.name)
        if (matches.length !== 1)
          throw new ResourceConfigError(
            `创建 ${describe(item)}（${item.name}）后查询到 ${matches.length} 个同名资源，已停止`,
          )
        if (ID_KINDS.includes(item.kind)) item.id = matches[0].id
        item.status = 'created'
        created.push(item)
      }
  } catch (cause) {
    for (const line of planLines(environment, mode, resources)) log(line)
    if (cause instanceof CloudflareApiError || cause instanceof ResourceConfigError)
      error(cause.message)
    else error(`解析失败：${cause?.name ?? 'Error'}`)
    if (created.length)
      error(`本次已创建（下次运行会沿用）：${created.map((item) => item.name).join('、')}`)
    return 1
  }

  for (const line of planLines(environment, mode, resources)) log(line)
  if (created.length) {
    const summary = `部署资源解析：env.${environment} 新建 ${created.map((item) => `${KIND_LABELS[item.kind]} ${item.name}`).join('、')}`
    log(`\n${summary}`)
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, `> [!WARNING]\n> ${summary}\n`)
  }
  if (resources.some((item) => item.status === 'found'))
    warnings.push('按名称找到的资源无法自动判定归属；确认它们不是同一账号中其他项目的同名资源。')
  for (const key of missingProjectVars(configs, environment))
    warnings.push(`${key} 为空，需要项目填写`)
  if (!env.CLOUDFLARE_ACCOUNT_ID)
    for (const app of APPS) {
      const vars = configs[app].env[environment].vars ?? {}
      for (const key of ACCOUNT_VARS)
        if (vars[key] === '')
          warnings.push(`${app} vars.${key} 为空，提供 CLOUDFLARE_ACCOUNT_ID 可补齐`)
    }
  for (const line of warnings) log(`提示：${line}`)

  const pending = resources.filter(
    (item) => item.status === 'missing' || item.status === 'cannot-create',
  )
  if (pending.length) {
    const lines = ['\n仍缺以下资源，未写出部署配置：']
    for (const item of pending) {
      if (item.status === 'cannot-create')
        lines.push(
          `- ${describe(item)}：期望名称 ${item.name}。按 docs/runbooks/staging-neon.md §3 在控制台创建（${/_CACHED$/.test(item.binding) ? '开启缓存 max_age=60' : '关闭缓存'}），或在本地运行 --apply --create-hyperdrive 并提供 HYPERDRIVE_APP_URL。`,
        )
      else lines.push(`- ${describe(item)}：期望名称 ${item.name}`)
    }
    if (pending.some((item) => item.status === 'missing'))
      lines.push(
        isProduction
          ? 'production 默认不创建资源；确认名称无误后，由维护者在本地运行 pnpm deploy:resources --env production --apply --allow-production。'
          : `加 --apply 创建上述资源：pnpm deploy:resources --env ${environment} --apply`,
      )
    error(lines.join('\n'))
    return 1
  }

  for (const app of APPS) {
    const deploy = applyResolution(configs[app], app, environment, resources, {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
    })
    writeFileSync(join(root, 'apps', app, DEPLOY_CONFIG), `${JSON.stringify(deploy, null, 2)}\n`)
  }
  log(`\n已写出 ${APPS.map((app) => `apps/${app}/${DEPLOY_CONFIG}`).join('、')}。ID 清单：`)
  for (const line of idList(environment, resources)) log(line)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  if (!existsSync(join(root, 'apps', 'web', 'wrangler.jsonc'))) {
    console.error('找不到 apps/web/wrangler.jsonc')
    process.exitCode = 1
  } else process.exitCode = await run({ root, argv: process.argv.slice(2), env: process.env })
}
