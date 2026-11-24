import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { defineTemplateConfig } from '@saas/config'
import {
  GENERATED_FILES,
  generatePlugins,
  loadPluginManifests,
  pluginMessageDirs,
  pluginRouteConfig,
  renderPluginFiles,
  resolveEnabledPlugins,
} from './plugins.mjs'

let root
const app = { name: 'T', url: 'https://example.com', supportEmail: 'a@example.com' }
const config = (plugins) => defineTemplateConfig({ app, plugins })

// both：两目标，全部入口与绑定；cfonly：仅 Cloudflare，带路由与文案
const both = {
  id: 'both',
  targets: ['cloudflare', 'node'],
  entries: {
    web: 'src/web.ts',
    worker: 'src/worker.ts',
    jobs: 'src/jobs.ts',
    webNode: 'src/web-node.ts',
    jobsNode: 'src/jobs-node.ts',
  },
  bindings: {
    web: [{ name: 'BOTH_WORKFLOW', kind: 'workflow', className: 'BothWorkflow' }],
    jobs: [{ name: 'AI', kind: 'ai', optional: true }],
  },
}
const cfOnly = {
  id: 'cf-only',
  targets: ['cloudflare'],
  routes: { dir: 'routes', mount: '' },
  messages: 'messages',
  entries: { web: 'src/web.ts', worker: 'src/worker.ts' },
  bindings: { web: [{ name: 'AGENT', kind: 'durable_object', className: 'Agent' }] },
}

function writePlugin(manifest) {
  const dir = join(root, 'plugins', manifest.id)
  for (const path of [
    ...Object.values(manifest.entries ?? {}),
    ...(manifest.routes ? [`${manifest.routes.dir}/x.tsx`] : []),
    ...(manifest.messages ? [`${manifest.messages}/en/x.json`] : []),
  ]) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), '')
  }
  // 清单不导入 @saas/config：definePlugin 只做校验并原样返回
  writeFileSync(join(dir, 'plugin.ts'), `export default ${JSON.stringify(manifest)}\n`)
  return dir
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'saas-plugins-'))
  writePlugin(both)
  writePlugin(cfOnly)
})
after(() => rmSync(root, { recursive: true, force: true }))

test('读取 plugins/*/plugin.ts，按 id 排序；目录名须与 id 一致', async () => {
  const loaded = await loadPluginManifests(root)
  assert.deepEqual(
    loaded.map(({ manifest }) => manifest.id),
    ['both', 'cf-only'],
  )
  const bad = mkdtempSync(join(tmpdir(), 'saas-plugins-bad-'))
  try {
    mkdirSync(join(bad, 'plugins/other'), { recursive: true })
    writeFileSync(join(bad, 'plugins/other/plugin.ts'), 'export default { id: "nope" }\n')
    await assert.rejects(
      loadPluginManifests(bad),
      /plugins\/other\/plugin\.ts: default export id must be other/,
    )
  } finally {
    rmSync(bad, { recursive: true, force: true })
  }
})

test('启用：生成文件导入启用插件入口，Worker / jobs 原样导出具名类，绑定随注册传给运行时校验', async () => {
  const loaded = await loadPluginManifests(root)
  const notices = []
  const { files, excluded } = await generatePlugins({
    root,
    config: config({ both: {}, 'cf-only': {} }),
    loaded,
    write: false,
    notify: (message) => notices.push(message),
  })
  const web = files[GENERATED_FILES.web]
  assert.match(web, /import bothWeb from '\.\.\/\.\.\/\.\.\/plugins\/both\/src\/web\.ts'/)
  assert.match(web, /import cfOnlyWeb from '\.\.\/\.\.\/\.\.\/plugins\/cf-only\/src\/web\.ts'/)
  assert.match(web, /\{ id: 'both', entry: bothWeb \},\n {2}\{ id: 'cf-only', entry: cfOnlyWeb \},/)
  const worker = files[GENERATED_FILES.worker]
  assert.match(worker, /export \* from '\.\.\/\.\.\/\.\.\/plugins\/cf-only\/src\/worker\.ts'/)
  assert.match(
    worker,
    /\{ id: 'cf-only', entry: cfOnlyWorker, bindings: \[\{ name: 'AGENT', kind: 'durable_object' \}\] \}/,
  )
  const jobs = files[GENERATED_FILES.jobs]
  assert.match(jobs, /export \* from '\.\.\/\.\.\/\.\.\/plugins\/both\/src\/jobs\.ts'/)
  assert.match(jobs, /bindings: \[\{ name: 'AI', kind: 'ai', optional: true \}\]/)
  assert.match(files[GENERATED_FILES.styles], /@source "\.\.\/\.\.\/\.\.\/\.\.\/plugins\/cf-only";/)
  // Node 产物排除仅 Cloudflare 的插件并提示
  for (const file of [
    GENERATED_FILES.webNode,
    GENERATED_FILES.jobsNode,
    GENERATED_FILES.stylesNode,
  ])
    assert.doesNotMatch(files[file], /cf-only|cfOnly/, file)
  assert.match(
    files[GENERATED_FILES.webNode],
    /export const nodePlugins[^\n]*\n {2}\{ id: 'both', entry: bothWebNode \}/,
  )
  assert.match(files[GENERATED_FILES.jobsNode], /\{ id: 'both', entry: bothJobsNode \}/)
  assert.deepEqual(
    excluded.map(({ manifest }) => manifest.id),
    ['cf-only'],
  )
  assert.deepEqual(notices, [
    '[plugins] 插件 cf-only 仅支持 Cloudflare，selfhost（Node）构建已排除',
  ])
})

test('关闭：生成文件不含任何插件导入，注册列表为空', async () => {
  const loaded = await loadPluginManifests(root)
  const plugins = resolveEnabledPlugins(config({}), loaded)
  const files = renderPluginFiles(root, plugins)
  for (const [path, content] of Object.entries(files)) {
    assert.doesNotMatch(content, /plugins\/(both|cf-only)/, path)
    if (path.endsWith('.ts')) assert.match(content, /= \[\]\n/, path)
  }
})

test('工具扩展点随 Cloudflare agents 启用，只在 Worker 启动时登记', async () => {
  const loaded = await loadPluginManifests(root)
  const other = loaded.find(({ manifest }) => manifest.id === 'cf-only')
  const agents = {
    dir: other.dir,
    manifest: { ...other.manifest, id: 'agents', entries: { worker: 'src/worker.ts' } },
  }
  const files = renderPluginFiles(
    root,
    resolveEnabledPlugins(config({ agents: {}, both: {} }), [...loaded, agents]),
  )

  assert.match(files[GENERATED_FILES.web], /import \* as bothAgentTools from /)
  assert.match(files[GENERATED_FILES.web], /\{ id: 'both', entry: bothAgentTools \}/)
  assert.match(
    files[GENERATED_FILES.worker],
    /registerPluginAgentTools\(agentToolPlugins, plugins\)/,
  )
  assert.doesNotMatch(files[GENERATED_FILES.webNode], /agentToolPlugins/)
  const withoutAgents = renderPluginFiles(root, resolveEnabledPlugins(config({ both: {} }), loaded))
  assert.doesNotMatch(withoutAgents[GENERATED_FILES.web], /agentToolPlugins/)
})

test('路由与文案按目标挂载：Node 不挂仅 Cloudflare 插件的路由与文案', async () => {
  const plugins = resolveEnabledPlugins(
    config({ both: {}, 'cf-only': {} }),
    await loadPluginManifests(root),
  )
  assert.deepEqual(pluginRouteConfig(root, plugins, 'cloudflare'), {
    type: 'root',
    file: '__root.tsx',
    children: [
      { type: 'physical', pathPrefix: '', directory: '.' },
      { type: 'physical', pathPrefix: '', directory: '../../../../plugins/cf-only/routes' },
    ],
  })
  assert.deepEqual(pluginRouteConfig(root, plugins, 'node').children, [
    { type: 'physical', pathPrefix: '', directory: '.' },
  ])
  assert.deepEqual(pluginMessageDirs(plugins, 'cloudflare'), [
    join(root, 'plugins/cf-only/messages'),
  ])
  assert.deepEqual(pluginMessageDirs(plugins, 'node'), [])
})

test('同一配置输出确定；内容不变时不重写文件', async () => {
  const loaded = await loadPluginManifests(root)
  const options = { root, config: config({ both: {}, 'cf-only': {} }), loaded, notify: () => {} }
  const first = await generatePlugins(options)
  const mtime = statSync(join(root, GENERATED_FILES.web)).mtimeMs
  const second = await generatePlugins(options)
  assert.deepEqual(second.files, first.files)
  assert.equal(statSync(join(root, GENERATED_FILES.web)).mtimeMs, mtime)
  assert.equal(
    readFileSync(join(root, GENERATED_FILES.web), 'utf8'),
    first.files[GENERATED_FILES.web],
  )
})

test('配置错误与清单路径缺失时失败并指出插件', async () => {
  const loaded = await loadPluginManifests(root)
  assert.throws(
    () => resolveEnabledPlugins(config({ nope: {} }), loaded),
    /plugins\.nope: unknown plugin \(available: both, cf-only\)/,
  )
  const missing = [
    {
      manifest: { ...cfOnly, entries: { web: 'src/missing.ts' } },
      dir: join(root, 'plugins/cf-only'),
    },
  ]
  assert.throws(
    () => resolveEnabledPlugins(config({ 'cf-only': {} }), missing),
    /plugin cf-only: entries\.web src\/missing\.ts does not exist/,
  )
})
