import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { defineTemplateConfig } from '@saas/config'
import { checkPlugins } from './check-plugins.mjs'

const sample = {
  id: 'sample',
  targets: ['cloudflare'],
  bindings: {
    web: [
      { name: 'CONVERSATION', kind: 'durable_object', className: 'Conversation' },
      { name: 'AI', kind: 'ai', optional: true },
    ],
    jobs: [{ name: 'REPORT_WORKFLOW', kind: 'workflow', className: 'ReportWorkflow' }],
  },
}

function withEnvironments(bindings) {
  return {
    ...bindings,
    env: { staging: structuredClone(bindings), production: structuredClone(bindings) },
  }
}

function fixture(t, { manifests = [sample], plugins = { sample: {} } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saas-check-plugins-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  function write(file, content) {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const config = defineTemplateConfig({
    app: { name: 'Test', url: 'https://example.com', supportEmail: 'test@example.com' },
    plugins,
  })
  write('template.config.ts', `export default ${JSON.stringify(config)}\n`)
  for (const manifest of manifests)
    write(`plugins/${manifest.id}/plugin.ts`, `export default ${JSON.stringify(manifest)}\n`)

  const web = withEnvironments({
    durable_objects: { bindings: [{ name: 'CONVERSATION', class_name: 'Conversation' }] },
  })
  const jobs = withEnvironments({
    workflows: [{ name: 'report', binding: 'REPORT_WORKFLOW', class_name: 'ReportWorkflow' }],
  })
  function check() {
    for (const [app, wrangler] of Object.entries({ web, jobs })) {
      const json = JSON.stringify(wrangler, null, 2)
      write(`apps/${app}/wrangler.jsonc`, `{\n  // 本地检查用配置${json.slice(1, -2)},\n}\n`)
    }
    return checkPlugins(root)
  }
  return { web, jobs, write, check }
}

test('对应 Worker 的三个环境各自声明必需绑定，可选绑定允许省略', async (t) => {
  const { web, jobs, check } = fixture(t)
  web.env.staging.ai = { binding: 'AI' }
  jobs.workflows.push({ name: 'other', binding: 'CORE_WORKFLOW', class_name: 'CoreWorkflow' })

  assert.deepEqual(await check(), [])
})

test('逐环境报告 web 和 jobs 缺失或类型错误的绑定', async (t) => {
  const { web, jobs, check } = fixture(t)
  delete web.durable_objects
  delete web.env.staging.durable_objects
  web.env.staging.r2_buckets = [{ binding: 'CONVERSATION' }]
  delete web.env.production
  delete jobs.workflows
  jobs.services = [{ binding: 'REPORT_WORKFLOW' }]
  delete jobs.env.staging.workflows
  delete jobs.env.production.workflows
  jobs.env.production.queues = { producers: [{ binding: 'REPORT_WORKFLOW' }] }

  assert.deepEqual(await check(), [
    'apps/web/wrangler.jsonc top-level: plugin sample binding CONVERSATION is missing (expected durable_object)',
    'apps/web/wrangler.jsonc env.staging: plugin sample binding CONVERSATION has kind r2, expected durable_object',
    'apps/web/wrangler.jsonc env.production: plugin sample binding CONVERSATION is missing (expected durable_object)',
    'apps/jobs/wrangler.jsonc top-level: plugin sample binding REPORT_WORKFLOW has kind service, expected workflow',
    'apps/jobs/wrangler.jsonc env.staging: plugin sample binding REPORT_WORKFLOW is missing (expected workflow)',
    'apps/jobs/wrangler.jsonc env.production: plugin sample binding REPORT_WORKFLOW has kind queue, expected workflow',
  ])
})

test('只供插件使用的限流绑定在任一环境缺失时报告（public-site-availability：运行时只让该插件 503）', async (t) => {
  const limited = {
    id: 'limited',
    targets: ['cloudflare'],
    bindings: { web: [{ name: 'RL_PLUGIN', kind: 'rate_limit' }] },
  }
  const { web, check } = fixture(t, {
    manifests: [sample, limited],
    plugins: { sample: {}, limited: {} },
  })
  const ratelimit = { name: 'RL_PLUGIN', namespace_id: '1001', simple: { limit: 10, period: 60 } }
  web.ratelimits = [ratelimit]
  web.env.staging.ratelimits = [{ ...ratelimit, namespace_id: '1002' }]

  assert.deepEqual(await check(), [
    'apps/web/wrangler.jsonc env.production: plugin limited binding RL_PLUGIN is missing (expected rate_limit)',
  ])
})

test('报告可选绑定的种类错误及类绑定引用了不同的类', async (t) => {
  const { web, check } = fixture(t)
  web.env.staging.kv_namespaces = [{ binding: 'AI' }]
  web.env.production.durable_objects.bindings[0].class_name = 'DifferentConversation'

  assert.deepEqual(await check(), [
    'apps/web/wrangler.jsonc env.staging: plugin sample binding AI has kind kv, expected ai',
    'apps/web/wrangler.jsonc env.production: plugin sample binding CONVERSATION references DifferentConversation, expected Conversation',
  ])
})

test('报告跨 Worker 且改名后仍引用未启用插件的 Durable Object 和 Workflow 绑定', async (t) => {
  const { web, jobs, check } = fixture(t, { plugins: {} })
  web.env = {
    preview: {
      workflows: [
        { binding: 'EXTERNAL_WORKFLOW', class_name: 'ReportWorkflow', script_name: 'jobs' },
      ],
    },
  }
  delete web.durable_objects
  delete jobs.workflows
  jobs.env = {
    production: {
      durable_objects: {
        bindings: [{ name: 'EXTERNAL_OBJECT', class_name: 'Conversation', script_name: 'web' }],
      },
    },
  }

  assert.deepEqual(await check(), [
    'apps/web/wrangler.jsonc env.preview: remove workflow binding EXTERNAL_WORKFLOW (ReportWorkflow belongs to disabled plugin sample)',
    'apps/jobs/wrangler.jsonc env.production: remove durable_object binding EXTERNAL_OBJECT (Conversation belongs to disabled plugin sample)',
  ])
})

test('清单中声明的入口必须是文件，路由和文案必须是目录', async (t) => {
  const { write, check } = fixture(t, {
    manifests: [
      {
        ...sample,
        entries: { web: 'missing.ts', worker: 'worker.ts' },
        routes: { dir: 'routes', mount: '' },
        messages: 'messages',
      },
      { id: 'inactive', targets: ['node'], messages: 'missing-messages' },
    ],
  })
  write('plugins/sample/worker.ts/child.ts', '')
  write('plugins/sample/routes', '')
  write('plugins/sample/messages/en/test.json', '{}')

  assert.deepEqual(await check(), [
    'plugins/inactive/plugin.ts: messages missing-messages does not exist',
    'plugins/sample/plugin.ts: entries.web missing.ts does not exist',
    'plugins/sample/plugin.ts: entries.worker worker.ts must be a file',
    'plugins/sample/plugin.ts: routes.dir routes must be a directory',
  ])
})

test('复用插件配置校验，拒绝缺少的依赖和非法部署目标', async (t) => {
  const { check } = fixture(t, {
    manifests: [{ ...sample, targets: ['unknown'], requires: { plugins: ['dependency'] } }],
  })

  await assert.rejects(check, {
    name: 'PluginConfigError',
    issues: [
      'plugin sample: targets must be a non-empty list of cloudflare / node',
      'plugins.sample requires plugin dependency; add plugins.dependency',
    ],
  })
})
