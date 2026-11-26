import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { scanArtifacts } from './plugins/check-artifacts.mjs'
import { GENERATED_FILES } from './plugins/plugins.mjs'
import { parseJsonc } from './production/check-wrangler-envs.mjs'

const generatorSkip = existsSync(new URL('./create-project.mjs', import.meta.url))
  ? false
  : '衍生项目已移除 scripts/create-project.mjs，跳过真实生成副本验收'
const { createProject, verifyProject } = generatorSkip ? {} : await import('./create-project.mjs')

// 显式运行的端到端自检：真正安装与检查完整副本，避免日常边界测试反复安装依赖。
test('真实副本通过 check、类型检查、单元测试和目标构建', {
  skip: generatorSkip,
}, async (t) => {
  for (const id of ['media', 'agents']) {
    assert.ok(
      existsSync(new URL(`../plugins/${id}/plugin.ts`, import.meta.url)),
      `验收需要已合并的 ${id} 插件`,
    )
  }
  const temp = await mkdtemp(join(tmpdir(), 'bootstrap-verify-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  await t.test('selfhost 拒绝 --plugins agents，且不创建副本', () => {
    const output = join(temp, 'invalid-selfhost-agents')
    const result = spawnSync(
      process.execPath,
      [
        'scripts/create-project',
        '--name',
        'invalid-selfhost-agents',
        '--domain',
        'invalid-selfhost-agents.example',
        '--target',
        'selfhost',
        '--plugins',
        'agents',
        '--output',
        output,
        '--skip-check',
      ],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8' },
    )
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /插件 agents 只支持 cloudflare，不能用于 selfhost/)
    assert.ok(!existsSync(output))
  })
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const sentinel = [
    'SELFHOST',
    'SENSITIVE',
    process.pid.toString(36),
    Date.now().toString(36),
  ].join('_')
  let selfhostSource
  for (const { id, label, expectedPlugins, ...scenario } of [
    {
      id: 'cf',
      label: 'Cloudflare 显式选择 --plugins agents',
      locale: 'en',
      plugins: 'agents',
      expectedPlugins: ['agents', 'media'],
    },
    {
      id: 'billing-off',
      label: 'Cloudflare 关闭计费',
      locale: 'en',
      'billing-enabled': 'false',
      expectedPlugins: ['admin-mcp'],
    },
    {
      id: 'selfhost',
      label: 'selfhost 默认（blue 主题）',
      target: 'selfhost',
      locale: 'zh',
      theme: 'blue',
      name: 'product-resources',
      expectedPlugins: ['admin-mcp', 'media', 'studio'],
    },
    {
      id: 'minimal',
      label: 'selfhost 全关，从已生成副本再次生成',
      target: 'selfhost',
      locale: 'zh',
      ai: '',
      plugins: '',
      'billing-enabled': 'false',
      'credits-enabled': 'false',
      marketing: 'false',
      i18n: 'false',
      expectedPlugins: [],
    },
  ]) {
    const webBuild = scenario.marketing === 'false'
    const nodeBuild = scenario.target === 'selfhost'
    const cloudflareBuild = !nodeBuild
    const builds = cloudflareBuild
      ? 'Cloudflare 构建'
      : webBuild
        ? 'Node 与 web 生产构建'
        : 'Node 构建'
    await t.test(`${label}：安装、check、类型、单元测试及 ${builds}通过`, async () => {
      const name = scenario.name ?? `validation-${id}-${process.pid.toString(36)}`
      const source = id === 'minimal' ? selfhostSource : undefined
      if (id === 'minimal') assert.ok(source, '全关组合必须从已生成的 selfhost 副本创建')
      const sourceName = source
        ? JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name
        : manifest.name
      if (source) {
        // 哨兵只写临时副本，证明已初始化项目再次生成时不继承真值与运行状态。
        for (const path of [
          'deploy/selfhost/secrets/auth_secret',
          'deploy/selfhost/certs/server/private',
          'deploy/selfhost/ownership/executor.json',
          'deploy/selfhost/backups/base.tar',
          'deploy/selfhost/release-state/current',
          '.env.local',
        ]) {
          await mkdir(dirname(join(source, path)), { recursive: true })
          await writeFile(join(source, path), sentinel)
        }
      }
      const result = await createProject(
        {
          ...scenario,
          name,
          domain: `${name}.example`,
          'image-namespace': `ghcr.io/validation-owner/${name}`,
          output: join(temp, name),
        },
        source,
      )
      if (id === 'selfhost') selfhostSource = result.target
      for (const path of Object.values(GENERATED_FILES)) {
        assert.ok(!existsSync(join(result.target, path)), `副本继承了插件生成文件：${path}`)
      }
      const base = JSON.parse(await readFile(join(result.target, '.template-base.json'), 'utf8'))
      assert.deepEqual(Object.keys(base).sort(), [
        'clean',
        'commit',
        'migrations',
        'params',
        'repository',
        'schemaVersion',
        'version',
      ])
      assert.equal(base.schemaVersion, 1)
      assert.equal(typeof base.clean, 'boolean')
      if (base.commit !== null) assert.match(base.commit, /^[a-f0-9]{40}$/)
      if (base.version !== null)
        assert.match(base.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/)
      if (base.repository !== null) {
        const repository = new URL(base.repository)
        assert.equal(repository.protocol, 'https:')
        for (const field of ['username', 'password', 'port', 'search', 'hash'])
          assert.equal(repository[field], '')
      }
      if (source) {
        assert.equal(base.clean, false)
        assert.equal(base.commit, null)
        assert.equal(base.repository, null)
        assert.equal(base.version, null)
      }
      assert.deepEqual(base.params, {
        ai: scenario['billing-enabled'] === 'false' ? [] : ['text', 'image', 'video'],
        billing: ['stripe', 'paypal'],
        'billing-enabled': scenario['billing-enabled'] !== 'false',
        'credits-enabled': scenario['credits-enabled'] !== 'false',
        domain: `https://${name}.example`,
        features: ['blog'],
        i18n: scenario.i18n !== 'false',
        'image-namespace': `ghcr.io/validation-owner/${name}`,
        locale: scenario.locale,
        marketing: scenario.marketing !== 'false',
        'media-providers': ['fal', 'workers-ai'],
        'multi-tenant': false,
        name,
        oauth: ['google', 'github'],
        // 显式传入 --plugins 时记录到基准参数，省略时按模板默认插件
        ...(scenario.plugins === undefined ? {} : { plugins: expectedPlugins }),
        'support-email': `support@${name}.example`,
        target: scenario.target ?? 'cloudflare',
        theme: scenario.theme ?? 'neutral',
        turnstile: true,
      })
      const journal = JSON.parse(
        await readFile(join(result.target, 'packages/db/migrations/meta/_journal.json'), 'utf8'),
      )
      assert.deepEqual(
        base.migrations,
        journal.entries.map((entry) => entry.tag),
      )
      for (const tag of base.migrations) assert.match(tag, /^\d{4}_[\w-]+$/)
      let count = 0
      async function inspect(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name)
          const projectPath = relative(result.target, path)
          assert.ok(!projectPath.includes(sourceName), `原名称仍存在于路径：${path}`)
          if (entry.isDirectory()) {
            assert.ok(
              ![
                '.git',
                'node_modules',
                '.wrangler',
                'dist',
                '.turbo',
                'coverage',
                '.output',
                '.content-collections',
                'project.inlang',
                'paraglide',
                'image-artifacts',
                'image-set',
                'secrets',
                'certs',
                '.data',
                'job-owners',
              ].includes(entry.name),
              `排除目录仍存在：${path}`,
            )
            if (projectPath.startsWith('deploy/selfhost/'))
              assert.ok(
                ![
                  'ownership',
                  '.ownership',
                  'owners',
                  'backups',
                  'backup-data',
                  'releases',
                  'release-state',
                  'state',
                  '.state',
                ].includes(entry.name),
                `selfhost 运行目录仍存在：${path}`,
              )
            await inspect(path)
          } else {
            assert.ok(!entry.isSymbolicLink())
            const content = await readFile(path)
            if (!content.includes(0)) {
              // 基准明确登记来源仓库与原迁移 tag；仅这两个已逐字段验证的值允许保留来源标识。
              const inspectedContent =
                projectPath === '.template-base.json'
                  ? JSON.stringify({ ...base, repository: null, migrations: [] })
                  : content.toString()
              assert.ok(!inspectedContent.includes(sourceName), `原名称仍存在：${path}`)
              assert.ok(!content.toString().includes(sentinel), `真值仍存在：${path}`)
              if (/^(?:\.agents|\.claude)\/skills\/.*\.md$/.test(projectPath)) {
                assert.doesNotMatch(content.toString(), /项目维护约定[、，\s`]+项目维护约定/)
                for (const [reference] of content.toString().matchAll(/docs\/[\w./-]+\.md/g)) {
                  // 与 create-project.test.mjs 一致：docs/design/ 下的 visual-system、forks 等由项目按需创建，
                  // 模板自己的原型索引不进衍生项目
                  if (/^docs\/(?:design|design-system\/prototypes)\//.test(reference)) continue
                  await assert.doesNotReject(
                    () => readFile(join(result.target, reference)),
                    `${projectPath} 引用不存在的文档：${reference}`,
                  )
                }
              }
              assert.doesNotMatch(
                inspectedContent,
                /docs\/runbooks\/evidence|saas-template-evidence|product-res-ecs|170a06d37ad50396b19943eb6b77a21d|ezarouter\.cc|ustclhx|\/Users\/hxlee/,
                `模板专属标识仍存在：${path}`,
              )
            }
            count++
          }
        }
      }
      await inspect(result.target)
      console.log(`已逐文件检查 ${count} 个文件，原名称、真值与排除目录均不存在`)
      if (scenario.target === 'selfhost') {
        assert.match(
          await readFile(join(result.target, 'deploy/selfhost/.env.example'), 'utf8'),
          new RegExp(`^IMAGE_NAMESPACE=ghcr.io/validation-owner/${name}$`, 'm'),
        )
        assert.match(
          await readFile(join(result.target, '.github/workflows/selfhost-publish.yml'), 'utf8'),
          new RegExp(`default: ghcr.io/validation-owner/${name}`),
        )
      }
      if (id === 'minimal') {
        assert.match(
          result.report,
          /billing=false \/ credits=false \/ marketing=false \/ i18n=false/,
        )
        assert.doesNotMatch(result.report, /billing:seed|STRIPE_SECRET|PAYPAL_CLIENT/)
      }
      for (const pluginId of ['media', 'agents', 'studio']) {
        assert.ok(existsSync(join(result.target, `plugins/${pluginId}/plugin.ts`)))
      }
      assert.deepEqual(result.options.plugins, expectedPlugins)
      // 显式 --plugins 覆盖模板默认插件，图片或视频照常启用 media。
      if (id === 'cf')
        assert.deepEqual(result.options.defaultPlugins, ['admin-mcp', ...expectedPlugins, 'studio'])
      for (const app of ['web', 'jobs']) {
        const wrangler = parseJsonc(
          await readFile(join(result.target, `apps/${app}/wrangler.jsonc`), 'utf8'),
        )
        if (!expectedPlugins.includes('media')) {
          assert.doesNotMatch(JSON.stringify(wrangler), /AI_MEDIA_WORKFLOW|AiMediaWorkflow/)
        }
        if (expectedPlugins.includes('agents') && app === 'web') {
          for (const scope of [wrangler, wrangler.env.staging, wrangler.env.production]) {
            assert.ok(
              scope.durable_objects?.bindings.some(
                ({ name, class_name }) =>
                  name === 'AGENT_CONVERSATION' && class_name === 'AgentConversation',
              ),
            )
          }
          assert.match(JSON.stringify(wrangler.migrations), /"AgentConversation"/)
        } else {
          assert.doesNotMatch(JSON.stringify(wrangler), /AGENT_CONVERSATION|AgentConversation/)
        }
      }
      // pnpm check 用 Git 索引枚举文件；保留无提交副本再次生成的测试条件。
      const gitOptions = { cwd: result.target }
      execFileSync('git', ['init', '--quiet'], gitOptions)
      try {
        execFileSync('git', ['add', '--all'], gitOptions)
        if (cloudflareBuild) {
          const before = execFileSync('git', ['write-tree'], {
            ...gitOptions,
            encoding: 'utf8',
          }).trim()
          const env = { ...process.env }
          delete env.CLOUDFLARE_API_TOKEN
          delete env.CLOUDFLARE_ACCOUNT_ID
          const plan = spawnSync('pnpm', ['deploy:resources', '--env', 'staging'], {
            cwd: result.target,
            env,
            encoding: 'utf8',
          })
          if (plan.error) throw plan.error
          assert.equal(plan.status, 1, `${plan.stdout}${plan.stderr}`)
          assert.match(plan.stdout, /资源解析计划：env\.staging（模式：plan）/)
          assert.ok(plan.stdout.includes(`${name}-cache-staging`), plan.stdout)
          assert.match(plan.stdout, /待查找（缺少凭据）/)
          assert.match(plan.stderr, /缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID/)
          execFileSync('git', ['diff', '--exit-code', before], gitOptions)
          console.log('已验证无凭据的 staging 计划退出 1，已跟踪文件无变化')
        }
        verifyProject(result.target, { nodeBuild, cloudflareBuild, webBuild })
      } finally {
        await rm(join(result.target, '.git'), { recursive: true, force: true })
      }
      const excludedMarkers = []
      if (!expectedPlugins.includes('studio')) excludedMarkers.push('/sitemap-gallery.xml')
      if (!expectedPlugins.includes('media')) {
        excludedMarkers.push(
          'AiMediaWorkflow',
          'fal.media',
          'MediaSubmitPage',
          'MediaTasksPage',
          '/internal/workflows/ai-media',
        )
      }
      if (!expectedPlugins.includes('agents')) {
        excludedMarkers.push(
          'AgentConversation',
          'routeAgentRequest',
          'agents.turn.start',
          'agents.turn.expired',
          '/app/$slug/agents',
          'plugins/agents/',
        )
      }
      if (excludedMarkers.length) {
        const only = [
          ...(cloudflareBuild || webBuild ? ['web'] : []),
          ...(cloudflareBuild ? ['jobs'] : []),
          ...(nodeBuild ? ['web-node', 'jobs-node'] : []),
        ]
        const hits = scanArtifacts(excludedMarkers, { root: result.target, only })
        for (const [artifact, matches] of Object.entries(hits)) {
          assert.ok(matches, `产物 ${artifact} 不存在`)
          for (const [marker, paths] of Object.entries(matches)) {
            assert.deepEqual(paths, [], `产物 ${artifact} 中仍包含 ${marker}`)
          }
        }
        console.log(`已检查 ${label} 的 ${only.join('、')} 产物，排除的插件标识均未命中`)
      }
      // 示例评测套件在生成的项目中离线回放可用；CI 为真保证不会发出真实模型调用。
      const evals = spawnSync('pnpm', ['eval:prompts', '--suite', 'example'], {
        cwd: result.target,
        env: { ...process.env, CI: 'true', EVIDENCE_DIR: join(temp, `${name}-evidence`) },
        encoding: 'utf8',
      })
      assert.equal(evals.status, 0, `${evals.stdout}${evals.stderr}`)
    })
  }
})
