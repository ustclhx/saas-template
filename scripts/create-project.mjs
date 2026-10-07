#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const featureNames = ['publicApi', 'blog', 'docs', 'waitlist', 'newsletter']
const aiNames = ['text', 'image', 'video']
const excluded = new Set([
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
  'playwright-report',
  'test-results',
  '.DS_Store',
  '.omp',
  '.codex',
])

function omit(path) {
  const parts = path.split('/')
  const name = parts.at(-1)
  return (
    parts.some((part) => excluded.has(part)) ||
    path === 'openspec/changes' ||
    path.startsWith('openspec/changes/') ||
    (path.startsWith('scripts/probes/') && parts.includes('results')) ||
    ((name === '.env' ||
      name.startsWith('.env.') ||
      name === '.dev.vars' ||
      name.startsWith('.dev.vars.')) &&
      !name.endsWith('.example')) ||
    name === 'routeTree.gen.ts' ||
    /\.(?:tsbuildinfo|log|pem|key|crt)$/.test(name)
  )
}

function list(value, allowed, label) {
  const items = value === '' ? [] : value.split(',')
  if (items.some((item) => !allowed.includes(item)) || new Set(items).size !== items.length) {
    throw new Error(`${label} 只接受：${allowed.join(',')}`)
  }
  return items
}

function boolean(value, label) {
  if (value !== 'true' && value !== 'false') throw new Error(`${label} 只接受 true 或 false`)
  return value === 'true'
}

function appValues(source) {
  const app = source.match(/app:\s*\{([^}]+)\}/)?.[1]
  if (!app) throw new Error('template.config.ts 缺少 app 配置')
  return Object.fromEntries(
    ['name', 'url', 'supportEmail'].map((key) => {
      const value = app.match(new RegExp(`${key}['"]?:\\s*['"]([^'"]+)['"]`))?.[1]
      if (!value) throw new Error(`template.config.ts 缺少 app.${key}`)
      return [key, value]
    }),
  )
}

export function projectOptions(input) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name ?? '') || input.name.length > 40) {
    throw new Error('名称必须为小写字母开头的 kebab-case，最多 40 字符')
  }
  const url = new URL(input.domain.includes('://') ? input.domain : `https://${input.domain}`)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.includes('.')
  ) {
    throw new Error('域名必须为 HTTPS 主机名，不含端口、路径或凭据')
  }
  if (!['en', 'zh'].includes(input.locale ?? 'en')) throw new Error('语言只接受 en 或 zh')
  const supportEmail = input['support-email'] ?? `support@${url.hostname}`
  if (!/^[\w.+-]+@[a-z0-9.-]+\.[a-z]+$/i.test(supportEmail)) throw new Error('支持邮箱格式无效')
  return {
    name: input.name,
    url: url.origin,
    supportEmail,
    locale: input.locale ?? 'en',
    ai: list(input.ai ?? 'text,image,video', aiNames, 'ai'),
    features: list(input.features ?? 'blog', featureNames, 'features'),
    billing: list(input.billing ?? 'stripe,paypal', ['stripe', 'paypal'], 'billing'),
    oauth: list(input.oauth ?? 'google,github', ['google', 'github'], 'oauth'),
    turnstile: boolean(input.turnstile ?? 'true', 'turnstile'),
    multiTenant: boolean(input['multi-tenant'] ?? 'false', 'multi-tenant'),
    target: resolve(input.target ?? join('..', input.name)),
  }
}

function templateConfig(source, options) {
  let result = source.replace(
    /app:\s*\{[^}]+\}/,
    `app: ${JSON.stringify({
      name: options.name,
      url: options.url,
      supportEmail: options.supportEmail,
    })}`,
  )
  result = result
    .replace(/defaultLocale:\s*['"][^'"]+['"]/, `defaultLocale: '${options.locale}'`)
    .replace(/multiTenant:\s*(?:true|false)/, `multiTenant: ${options.multiTenant}`)
    .replace(/oauth:\s*\[[^\]]*\]/, `oauth: ${JSON.stringify(options.oauth)}`)
    .replace(/turnstile:\s*(?:true|false)/, `turnstile: ${options.turnstile}`)
    .replace(/providers:\s*\[[^\]]*\]/, `providers: ${JSON.stringify(options.billing)}`)
  for (const name of aiNames) {
    result = result.replace(
      new RegExp(`${name}:\\s*(?:true|false)`),
      `${name}: ${options.ai.includes(name)}`,
    )
  }
  return result.replace(
    /features:\s*\{[^}]*\}/,
    `features: ${JSON.stringify(
      Object.fromEntries(featureNames.map((name) => [name, options.features.includes(name)])),
    )}`,
  )
}

// 仅在配置语义位置改 Worker / Queue 名；资源 ID 清空，避免新项目复用模板的 staging。
function wranglerConfig(source, options, app) {
  const media = options.ai.includes('image') || options.ai.includes('video')
  let result = source
    .replace(
      /("(?:name|script_name|queue|bucket_name)"\s*:\s*")([^"\n]+)"/g,
      (_match, prefix, value) =>
        /^(?:web|jobs|email|events|ai-media)(?:-staging)?$/.test(value)
          ? `${prefix}${options.name}-${value}"`
          : `${prefix}${value}"`,
    )
    .replace(/("id"\s*:\s*")[a-f0-9]{32}"/g, '$100000000000000000000000000000000"')
    .replace(/("APP_URL"\s*:\s*")https:[^"]+"/g, `$1${options.url}"`)
  if (!media) result = result.replace(/"workflows"\s*:\s*\[[\s\S]*?\],?/g, '')
  if (app === 'web' && !options.turnstile) {
    result = result.replace(/,?\s*"TURNSTILE_SITE_KEY"\s*:\s*"[^"]+"/g, '')
  }
  return result
}

export function setupChecklist(options) {
  const media = options.ai.includes('image') || options.ai.includes('video')
  const resources = [
    'Postgres（app / migrator / readonly 账号、备份）及 Cloudflare Tunnel / Workers VPC',
    `Workers：${options.name}-web、${options.name}-jobs（staging 使用 -staging 后缀）`,
    'Hyperdrive：HYPERDRIVE（关缓存）/ HYPERDRIVE_CACHED（开缓存），替换所有环境的 id',
    'KV：CACHE，替换所有环境的 id；Rate Limiting：RL_AUTH / RL_AI，分配独立 namespace_id',
    `Queues：${options.name}-email、${options.name}-events（staging 使用 -staging 后缀）`,
    'Resend：验证发件域名；本地 EMAIL_TRANSPORT=log 不需要凭据',
    '域名 / DNS 与 Cloudflare 部署账号；CI 的 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID',
  ]
  const secrets = ['BETTER_AUTH_SECRET', 'RESEND_API_KEY']
  const vars = ['APP_URL', 'EMAIL_TRANSPORT', 'EMAIL_FROM', 'EMAIL_REPLY_TO']
  for (const provider of options.oauth) {
    resources.push(`${provider} OAuth 应用：登记新域名的回调 URL`)
    secrets.push(`${provider.toUpperCase()}_CLIENT_ID`, `${provider.toUpperCase()}_CLIENT_SECRET`)
  }
  if (options.turnstile) {
    resources.push('Turnstile 站点')
    secrets.push('TURNSTILE_SECRET_KEY')
    vars.push('TURNSTILE_SITE_KEY')
  }
  for (const provider of options.billing) {
    resources.push(`${provider} 账号与 Webhook（先测试 / 沙箱）`)
    secrets.push(
      ...(provider === 'stripe'
        ? ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
        : ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID']),
    )
    if (provider === 'paypal') vars.push('PAYPAL_ENV')
  }
  if (options.ai.includes('text')) {
    resources.push('AI Gateway 与至少一家文本模型服务商；后台登记模型与价格')
    secrets.push('AI_GATEWAY_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY')
    vars.push('AI_GATEWAY_ACCOUNT_ID', 'AI_GATEWAY_ID')
  }
  if (media) {
    resources.push(
      `Workflow：${options.name}-ai-media（定义在 jobs，web 的 script_name 指向 jobs）`,
      'R2：FILES 桶（绑定与 CORS）及仅授权该桶的 S3 令牌',
      'fal.ai 账号与回调地址',
    )
    secrets.push('FAL_KEY', 'MEDIA_WEBHOOK_SECRET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    vars.push('R2_ACCOUNT_ID', 'R2_FILES_BUCKET')
  }
  return { resources, secrets, vars }
}

async function replacements(source, options, app) {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const pairs = [
    [manifest.name, options.name],
    [app.name, options.name],
    [app.url, options.url],
    [app.supportEmail, options.supportEmail],
    ['SaaS Template', options.name],
    ['SaaS template', options.name],
  ]
  for (const folder of ['apps', 'packages']) {
    for (const name of await readdir(join(source, folder))) {
      const file = join(source, folder, name, 'package.json')
      try {
        const pkg = JSON.parse(await readFile(file, 'utf8'))
        if (pkg.name.startsWith('@'))
          pairs.push([`${pkg.name.split('/')[0]}/`, `@${options.name}/`])
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  // 数据库 / Orca 命名与隔离检查必须同步改名。
  const scope = pairs.find(([from]) => from.startsWith('@'))?.[0].slice(1, -1)
  if (scope)
    pairs.push(
      [`${scope}-`, `${options.name}-`],
      [`${scope}_`, `${options.name.replaceAll('-', '_')}_`],
      [`${scope.toUpperCase()}_`, `${options.name.replaceAll('-', '_').toUpperCase()}_`],
    )
  const map = new Map(pairs.filter(([from]) => from))
  const pattern = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return (value) => value.replace(new RegExp(pattern, 'g'), (match) => map.get(match))
}

export async function createProject(input, source = root) {
  const options = projectOptions(input)
  const sourcePath = await realpath(source)
  const lexicalRel = relative(sourcePath, options.target)
  if (
    !lexicalRel ||
    (lexicalRel !== '..' && !lexicalRel.startsWith(`..${sep}`) && !isAbsolute(lexicalRel))
  ) {
    throw new Error('目标不能位于模板目录内')
  }
  // realpath 父目录避免通过符号链接把输出放回源树中。
  await mkdir(dirname(options.target), { recursive: true })
  const target = join(await realpath(dirname(options.target)), basename(options.target))
  const rel = relative(sourcePath, target)
  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new Error('目标不能位于模板目录内')
  try {
    await access(target, constants.F_OK)
    throw new Error('目标已存在，请使用新的目录')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const config = await readFile(join(sourcePath, 'template.config.ts'), 'utf8')
  const replace = await replacements(sourcePath, options, appValues(config))
  await mkdir(target)
  async function copy(folder = '') {
    for (const name of await readdir(join(sourcePath, folder))) {
      const path = folder ? `${folder}/${name}` : name
      if (omit(path)) continue
      const from = join(sourcePath, path)
      const to = join(target, replace(path))
      const stat = await lstat(from)
      // 不跟随链接，防止源目录外的密钥或共享缓存进入副本。
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await mkdir(to, { recursive: true })
        await copy(path)
      } else if (stat.isFile()) {
        const buffer = await readFile(from)
        let content = buffer
        let decoded = null
        if (!buffer.includes(0)) {
          try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
          } catch {
            // 无效 UTF-8 为二进制，原样复制。
          }
        }
        if (decoded !== null) {
          let text = decoded
          if (path === 'template.config.ts') text = templateConfig(text, options)
          if (/^apps\/(web|jobs)\/wrangler.jsonc$/.test(path)) {
            text = wranglerConfig(text, options, path.split('/')[1])
          }
          content = Buffer.from(replace(text))
        }
        await writeFile(to, content)
        await chmod(to, stat.mode & 0o777)
      }
    }
  }
  await copy()
  const checklist = setupChecklist(options)
  const vars = [...checklist.vars, ...checklist.secrets].map((key) => `${key}=`).join('\n')
  const example = `# 仅为空值；复制到对应 app 的 .dev.vars 后填写，本文件不含真实密钥。\n${vars}\n`
  await writeFile(join(target, '.dev.vars.example'), example)
  for (const app of ['web', 'jobs']) {
    await writeFile(join(target, 'apps', app, '.dev.vars.example'), example)
  }
  const report = `# ${options.name} 初始化清单\n\n## 基础设施与账号\n\n${checklist.resources.map((s) => `- [ ] ${s}`).join('\n')}\n\n## Secrets\n\n${checklist.secrets.map((s) => `- ${s}`).join('\n')}\n\n## 非敏感 Vars\n\n${checklist.vars.map((s) => `- ${s}`).join('\n')}\n\n所有部署资源 ID 为占位值，部署前逐项配置；参考 docs/07-infrastructure.md。\n复制 apps/web 与 apps/jobs 的 .dev.vars.example 后填写，本地密钥不提交。\n自检只运行单元测试，集成测试需独立数据库与迁移配置；上线前另做 staging 验收。\n`
  await writeFile(join(target, 'PROJECT_SETUP.md'), report)
  return { target, options, checklist, report }
}

export function verifyProject(target) {
  // 清除调用者的数据库真值，CI 模式关闭本地库 fallback；不对模板数据库执行测试。
  const env = { ...process.env, CI: 'true', TURBO_ENV_MODE: 'loose', TURBO_TELEMETRY_DISABLED: '1' }
  for (const key of Object.keys(env)) {
    if (/DATABASE_URL|HYPERDRIVE_LOCAL_CONNECTION_STRING/.test(key)) delete env[key]
  }
  for (const args of [['install', '--frozen-lockfile'], ['typecheck'], ['test']]) {
    const result = spawnSync('pnpm', args, { cwd: target, env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`副本 pnpm ${args.join(' ')} 失败（${result.status}）`)
  }
}

const help = `用法：pnpm create-project [参数]\n无参数时交互输入；非交互必须提供 --name 与 --domain。\n  --name acme --domain acme.example --target /tmp/acme\n  --locale en|zh --support-email support@acme.example\n  --ai text,image,video --features blog,docs,waitlist,newsletter,publicApi\n  --billing stripe,paypal --oauth google,github\n  --turnstile true|false --multi-tenant true|false\n列表参数传空字符串可关闭全部；默认 ai / billing / oauth 全开，features=blog。\n默认安装依赖并运行 typecheck 与单元测试；--skip-check 仅生成，随后必须自行验证。\n  --help 显示帮助\n`

export async function main() {
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(
        [
          'name',
          'domain',
          'target',
          'locale',
          'support-email',
          'ai',
          'features',
          'billing',
          'oauth',
          'turnstile',
          'multi-tenant',
        ].map((name) => [name, { type: 'string' }]),
      ),
      help: { type: 'boolean' },
      'skip-check': { type: 'boolean' },
    },
  })
  if (values.help) return console.log(help)
  if (!values.name || !values.domain) {
    if (!process.stdin.isTTY) throw new Error('非交互模式必须提供 --name 与 --domain')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      for (const [key, label, fallback] of [
        ['name', '项目名称（kebab-case）', ''],
        ['domain', '域名', ''],
        ['target', '输出目录', values.name ?? ''],
        ['locale', '默认语言', 'en'],
        ['ai', 'AI 功能（逗号列表）', 'text,image,video'],
        ['features', '可选功能（逗号列表，- 关闭全部）', 'blog'],
        ['billing', '支付（逗号列表，- 关闭全部）', 'stripe,paypal'],
        ['oauth', 'OAuth（逗号列表，- 关闭全部）', 'google,github'],
        ['turnstile', 'Turnstile', 'true'],
        ['multi-tenant', '多租户', 'false'],
      ]) {
        if (values[key] !== undefined) continue
        const suggestion = key === 'target' ? join('..', values.name) : fallback
        const answer = (
          await rl.question(`${label}${suggestion ? ` [${suggestion}]` : ''}：`)
        ).trim()
        values[key] = answer === '-' ? '' : answer || suggestion
      }
    } finally {
      rl.close()
    }
  }
  const result = await createProject(values)
  console.log(`已生成：${result.target}\n${result.report}`)
  if (!values['skip-check']) verifyProject(result.target)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`创建失败：${error.message}`)
    process.exitCode = 1
  })
}
