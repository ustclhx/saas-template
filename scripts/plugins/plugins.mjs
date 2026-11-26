// 构建期插件注册（openspec add-plugin-system 决策 3）：读取 template.config.ts 的 `plugins` 段与
// plugins/<id>/plugin.ts 清单，校验后生成注册文件（均已 gitignore）。核心只从这些生成文件进入插件，
// 未启用插件不在任何导入链上，因此不进入 web（Worker / Node）与 jobs 的构建产物。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginsForTarget, resolvePlugins } from '@saas/config'
import { adminMcpContributors } from './admin-mcp-tools.mjs'

export const REPO_ROOT = resolve(import.meta.dirname, '../..')

/** 生成文件（相对仓库根）；与 .gitignore、Turbo outputs 保持一致 */
export const GENERATED_FILES = {
  web: 'apps/web/src/plugins.gen.ts',
  worker: 'apps/web/src/plugins.worker.gen.ts',
  webNode: 'apps/web/src/plugins.node.gen.ts',
  adminMcp: 'apps/web/src/plugins.admin-mcp.gen.ts',
  adminMcpNode: 'apps/web/src/plugins.admin-mcp.node.gen.ts',
  styles: 'apps/web/src/styles/plugins.gen.css',
  stylesNode: 'apps/web/src/styles/plugins.node.gen.css',
  jobs: 'apps/jobs/src/plugins.gen.ts',
  jobsNode: 'apps/jobs/src/plugins.node.gen.ts',
}

/**
 * Node 注册文件的类型来源（相对仓库根）。只部署 Cloudflare 的项目删除 Node 入口（含这两个文件）后，
 * 不再生成对应的 *.node.gen.*，避免生成文件引用已删除的 Node 入口与 `@scope/config/node` 等导出。
 */
export const NODE_PLUGIN_CONTRACTS = {
  web: 'apps/web/src/node/plugins.ts',
  jobs: 'apps/jobs/src/node/plugins.ts',
}

/**
 * web 两目标共用的代码只导入 Cloudflare 注册文件；Node 构建（vite.node.config.ts）
 * 把它们解析为 Node 版本，排除仅 Cloudflare 的插件。键与值均相对仓库根。
 */
export const NODE_WEB_ALIASES = {
  [GENERATED_FILES.web]: GENERATED_FILES.webNode,
  [GENERATED_FILES.adminMcp]: GENERATED_FILES.adminMcpNode,
  [GENERATED_FILES.styles]: GENERATED_FILES.stylesNode,
}

/** 读取 plugins/<id>/plugin.ts；目录名必须与清单 id 一致 */
export async function loadPluginManifests(root = REPO_ROOT) {
  const pluginsDir = join(root, 'plugins')
  if (!existsSync(pluginsDir)) return []
  const loaded = []
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(pluginsDir, entry.name)
    const file = join(dir, 'plugin.ts')
    if (!existsSync(file)) continue
    const manifest = (await import(pathToFileURL(file).href)).default
    if (manifest?.id !== entry.name)
      throw new Error(`plugins/${entry.name}/plugin.ts: default export id must be ${entry.name}`)
    loaded.push({ manifest, dir })
  }
  return loaded.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
}

export async function loadTemplateConfig(root = REPO_ROOT) {
  return (await import(pathToFileURL(join(root, 'template.config.ts')).href)).default
}

/** 校验配置并返回启用插件（按 id 排序）：{ manifest, dir, config } */
export function resolveEnabledPlugins(config, loaded) {
  const dirs = new Map(loaded.map(({ manifest, dir }) => [manifest.id, dir]))
  const resolved = resolvePlugins(
    config,
    loaded.map(({ manifest }) => manifest),
  )
  for (const plugin of resolved) {
    const dir = dirs.get(plugin.manifest.id)
    const paths = [
      ...Object.entries(plugin.manifest.entries ?? {}).map(([kind, path]) => [
        `entries.${kind}`,
        path,
      ]),
      ...(plugin.manifest.routes ? [['routes.dir', plugin.manifest.routes.dir]] : []),
      ...(plugin.manifest.messages ? [['messages', plugin.manifest.messages]] : []),
    ]
    for (const [field, path] of paths)
      if (!existsSync(join(dir, path)))
        throw new Error(`plugin ${plugin.manifest.id}: ${field} ${path} does not exist`)
  }
  return resolved.map((plugin) => ({ ...plugin, dir: dirs.get(plugin.manifest.id) }))
}

/** 从生成文件所在目录到插件内文件的 import 路径（POSIX，带 ./ 前缀） */
function importPath(root, generated, dir, file) {
  const path = relative(dirname(join(root, generated)), join(dir, file))
    .split(sep)
    .join('/')
  return path.startsWith('.') ? path : `./${path}`
}

/** 入口的导入名：插件 id 驼峰化 + 入口种类，如 media-studio 的 jobsNode → mediaStudioJobsNode */
function entryName(id, kind) {
  const camel = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
  return `${camel}${kind[0].toUpperCase()}${kind.slice(1)}`
}

const HEADER =
  '// 由 scripts/plugins/generate.mjs 按 template.config.ts 的 plugins 段生成（已 gitignore），勿手改。\n'

/** 绑定声明的字面量（只保留运行时校验用到的字段） */
function bindingsLiteral(bindings = []) {
  const items = bindings.map(
    ({ name, kind, optional }) =>
      `{ name: '${name}', kind: '${kind}'${optional ? ', optional: true' : ''} }`,
  )
  return `[${items.join(', ')}]`
}

/**
 * 注册模块：每个列表为 `{ id, entry?, bindings? }`（entry 为入口模块的 default 导出），第一个列表为 default 导出。
 * 列表声明 `bindings`（web / jobs）时，声明了该侧绑定但没有入口的插件也在列表中，供运行时校验绑定；
 * `reexport` 时另 `export *` 入口的具名导出（Durable Object / Workflow 类等，由 Worker 入口原样导出）。
 */
function registry(
  root,
  generated,
  plugins,
  lists,
  { typeFrom, reexport = false, agentToolEntries, agentsWorker },
) {
  const lines = [HEADER]
  // 列表可声明自己的 typeFrom（如 Node 入口类型），其余从共用契约导入
  const typeSources = Map.groupBy(lists, (list) => list.typeFrom ?? typeFrom)
  for (const [source, sourced] of typeSources)
    lines.push(`import type { ${sourced.map((list) => list.type).join(', ')} } from '${source}'`)
  for (const list of lists)
    for (const { manifest, dir } of plugins)
      if (manifest.entries?.[list.kind])
        lines.push(
          `import ${entryName(manifest.id, list.kind)} from '${importPath(root, generated, dir, manifest.entries[list.kind])}'`,
        )
  if (agentToolEntries) {
    lines.push(`import type { WebAgentToolRegistration } from '${typeFrom}'`)
    for (const { manifest, dir } of agentToolEntries)
      lines.push(
        `import * as ${entryName(manifest.id, 'agentTools')} from '${importPath(root, generated, dir, manifest.entries.web)}'`,
      )
  }
  if (agentsWorker) {
    const { dir, manifest } = agentsWorker
    lines.push("import { agentToolPlugins } from './plugins.gen.ts'")
    lines.push(
      `import { registerPluginAgentTools } from '${importPath(root, generated, dir, manifest.entries.worker)}'`,
    )
  }
  if (reexport)
    for (const { manifest, dir } of plugins)
      if (manifest.entries?.[lists[0].kind])
        lines.push(
          `export * from '${importPath(root, generated, dir, manifest.entries[lists[0].kind])}'`,
        )
  for (const [index, list] of lists.entries()) {
    lines.push('')
    lines.push(`${index === 0 ? '' : 'export '}const ${list.name}: readonly ${list.type}[] = [`)
    for (const { manifest } of plugins) {
      const entry = manifest.entries?.[list.kind]
      const bindings = list.bindings ? (manifest.bindings?.[list.bindings] ?? []) : []
      if (!entry && bindings.length === 0) continue
      const fields = [`id: '${manifest.id}'`]
      if (entry) fields.push(`entry: ${entryName(manifest.id, list.kind)}`)
      if (list.bindings) fields.push(`bindings: ${bindingsLiteral(bindings)}`)
      lines.push(`  { ${fields.join(', ')} },`)
    }
    if (lines.at(-1)?.endsWith('= [')) lines[lines.length - 1] += ']'
    else lines.push(']')
  }
  if (agentToolEntries) {
    const entries = agentToolEntries.map(
      ({ manifest }) => `{ id: '${manifest.id}', entry: ${entryName(manifest.id, 'agentTools')} }`,
    )
    lines.push(
      `export const agentToolPlugins: readonly WebAgentToolRegistration[] = [${entries.join(', ')}]`,
    )
  }
  // 第二个参数为 Worker 插件注册表：对话实例据此取得插件提供的 AI 任务工作流（工具的 services）
  if (agentsWorker) lines.push('registerPluginAgentTools(agentToolPlugins, plugins)')
  lines.push(`export default ${lists[0].name}`)
  return `${lines.join('\n')}\n`
}

/** MCP 只加载工具贡献者，后台确认和协议处理不依赖导航注册表。 */
function adminMcpRegistry(root, generated, plugins, contributors) {
  const lines = [HEADER, "import type { AdminMcpToolFactory } from './features/admin/mcp-tool.ts'"]
  const entries = []
  if (plugins.some(({ manifest }) => manifest.id === 'admin-mcp')) {
    for (const { manifest, dir } of plugins) {
      if (!contributors.has(manifest.id)) continue
      const name = entryName(manifest.id, 'adminMcpTools')
      lines.push(
        `import { adminMcpTools as ${name} } from '${importPath(root, generated, dir, manifest.entries.web)}'`,
      )
      entries.push(name)
    }
  }
  lines.push(
    `\nexport const adminMcpToolPlugins: readonly (() => Readonly<Record<string, AdminMcpToolFactory>>)[] = [${entries.join(', ')}]`,
  )
  return `${lines.join('\n')}\n`
}

function styles(root, generated, plugins) {
  const lines = [
    '/* 由 scripts/plugins/generate.mjs 生成（已 gitignore）：启用插件的 Tailwind 扫描目录，只含 @source */',
  ]
  for (const { dir } of plugins)
    lines.push(
      `@source "${relative(dirname(join(root, generated)), dir)
        .split(sep)
        .join('/')}";`,
    )
  return `${lines.join('\n')}\n`
}

/**
 * 生成文件内容（相对路径 → 内容）。Cloudflare 文件含全部启用插件（插件都支持 Cloudflare 时）；
 * *.node.gen.* 只含 targets 包含 node 的插件，Node 构建经 NODE_WEB_ALIASES 只读取它们；
 * 项目没有对应的 Node 入口契约（NODE_PLUGIN_CONTRACTS）时不生成该侧的 Node 文件。
 */
export function renderPluginFiles(root, plugins) {
  const node = pluginsForTarget(plugins, 'node').included
  const cloudflare = pluginsForTarget(plugins, 'cloudflare').included
  const web = { typeFrom: './features/plugins/contract.ts' }
  const jobs = { typeFrom: './plugins/contract.ts' }
  const adminMcpIds = adminMcpContributors(root, plugins)
  const agentsWorker = cloudflare.find(
    ({ manifest }) => manifest.id === 'agents' && manifest.entries?.worker,
  )
  const agentToolEntries = agentsWorker
    ? cloudflare.filter(({ manifest }) => manifest.id !== 'agents' && manifest.entries?.web)
    : undefined
  const files = {
    [GENERATED_FILES.web]: registry(
      root,
      GENERATED_FILES.web,
      cloudflare,
      [{ name: 'plugins', kind: 'web', type: 'WebPluginRegistration' }],
      { ...web, agentToolEntries },
    ),
    [GENERATED_FILES.adminMcp]: adminMcpRegistry(
      root,
      GENERATED_FILES.adminMcp,
      cloudflare,
      adminMcpIds,
    ),
    [GENERATED_FILES.worker]: registry(
      root,
      GENERATED_FILES.worker,
      cloudflare,
      [{ name: 'plugins', kind: 'worker', type: 'WorkerPluginRegistration', bindings: 'web' }],
      { typeFrom: './server/cloudflare/plugins.ts', reexport: true, agentsWorker },
    ),
    [GENERATED_FILES.styles]: styles(root, GENERATED_FILES.styles, cloudflare),
    [GENERATED_FILES.jobs]: registry(
      root,
      GENERATED_FILES.jobs,
      cloudflare,
      [{ name: 'plugins', kind: 'jobs', type: 'JobsPluginRegistration', bindings: 'jobs' }],
      { ...jobs, reexport: true },
    ),
  }
  if (existsSync(join(root, NODE_PLUGIN_CONTRACTS.web))) {
    Object.assign(files, {
      // default 导出与 plugins.gen.ts 同形（Node 构建的别名目标），nodePlugins 为 webNode 入口
      [GENERATED_FILES.webNode]: registry(
        root,
        GENERATED_FILES.webNode,
        node,
        [
          { name: 'plugins', kind: 'web', type: 'WebPluginRegistration' },
          {
            name: 'nodePlugins',
            kind: 'webNode',
            type: 'WebNodePluginRegistration',
            typeFrom: './node/plugins.ts',
          },
        ],
        web,
      ),
      [GENERATED_FILES.adminMcpNode]: adminMcpRegistry(
        root,
        GENERATED_FILES.adminMcpNode,
        node,
        adminMcpIds,
      ),
      [GENERATED_FILES.stylesNode]: styles(root, GENERATED_FILES.stylesNode, node),
    })
  }
  if (existsSync(join(root, NODE_PLUGIN_CONTRACTS.jobs)))
    Object.assign(files, {
      [GENERATED_FILES.jobsNode]: registry(
        root,
        GENERATED_FILES.jobsNode,
        node,
        [{ name: 'plugins', kind: 'jobsNode', type: 'JobsNodePluginRegistration' }],
        { typeFrom: './node/plugins.ts' },
      ),
    })
  return files
}

/**
 * TanStack Router 虚拟路由（决策 4）：核心 src/routes 原样挂在根下，再挂载目标支持的启用插件的路由目录。
 * 路径相对 routesDirectory（apps/web/src/routes）。
 */
export function pluginRouteConfig(root, plugins, target) {
  const routesDir = join(root, 'apps/web/src/routes')
  return {
    type: 'root',
    file: '__root.tsx',
    children: [
      { type: 'physical', pathPrefix: '', directory: '.' },
      ...pluginsForTarget(plugins, target)
        .included.filter(({ manifest }) => manifest.routes)
        .map(({ manifest, dir }) => ({
          type: 'physical',
          pathPrefix: manifest.routes.mount ? `/${manifest.routes.mount}` : '',
          directory: relative(routesDir, join(dir, manifest.routes.dir)).split(sep).join('/'),
        })),
    ],
  }
}

/** 启用插件的文案目录（绝对路径）；目标不支持的插件不编译其文案 */
export function pluginMessageDirs(plugins, target) {
  return pluginsForTarget(plugins, target)
    .included.filter(({ manifest }) => manifest.messages)
    .map(({ manifest, dir }) => join(dir, manifest.messages))
}

/** 内容不变时不写，避免触发 dev 热更新与重复编译 */
function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return true
}

/**
 * 校验并写出全部生成文件；返回启用插件与仅 Cloudflare 而被 Node 产物排除的插件。
 * `notify` 接收给使用者的提示（selfhost 排除）。
 */
export async function generatePlugins({
  root = REPO_ROOT,
  config,
  loaded,
  write = true,
  notify = (message) => console.warn(message),
} = {}) {
  const templateConfig = config ?? (await loadTemplateConfig(root))
  const manifests = loaded ?? (await loadPluginManifests(root))
  const plugins = resolveEnabledPlugins(templateConfig, manifests)
  const files = renderPluginFiles(root, plugins)
  const excluded = pluginsForTarget(plugins, 'node').excluded
  for (const { manifest } of excluded)
    notify(`[plugins] 插件 ${manifest.id} 仅支持 Cloudflare，selfhost（Node）构建已排除`)
  if (write) {
    for (const [path, content] of Object.entries(files)) writeIfChanged(join(root, path), content)
    // 删除 Node 入口后，移除之前生成、已不再生成的 Node 注册文件
    for (const path of Object.values(GENERATED_FILES))
      if (!(path in files)) rmSync(join(root, path), { force: true })
  }
  return { plugins, files, excluded }
}
