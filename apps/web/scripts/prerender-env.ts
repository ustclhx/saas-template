// 预渲染使用的本地 preview Worker 的环境变量（openspec add-marketing-i18n-seo tasks.md 3.1）。
//
// TanStack Start 的预渲染在构建后启动 preview（workerd）请求页面；preview 读取 Cloudflare 插件写入
// dist/server/.dev.vars 的本地变量。没有 .dev.vars 的环境（CI）中 Worker 入口的启动校验会让所有页面返回 500，
// 这里改用 .dev.vars.example 的假值 / 公开测试值（签名密钥每次构建随机生成），仅用于本地 preview：
// .dev.vars 不随部署上传。预渲染的页面不读取任何密钥，取值不影响输出。
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

const WEB_ROOT = new URL('..', import.meta.url).pathname
const previewAuthDefaults: Record<string, string> = {
  GITHUB_CLIENT_ID: 'fake-github-client-id',
  GOOGLE_CLIENT_ID: 'fake-google-client-id',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
}

/**
 * 本地 preview 变量：以 .dev.vars.example 为基础（没有示例文件时返回 null）。
 * - 生成副本示例中的空 OAuth ID 与 Turnstile 凭据用假 ID 和公开测试值填充。
 * - 示例中值为空的 `*_SECRET` / `*_TOKEN` 每次随机生成：项目新增的必填密钥（如预渲染令牌）只需在示例中写空值；
 * - 本地有 apps/web/.dev.vars 时叠加其中的值（与 Cloudflare 插件构建时复制的内容一致；CI 的构建任务没有这个文件，仍只用示例值）；
 * - 环境变量 APP_URL 覆盖示例值（CI 以此指定站点地址）。
 * 构建后链接图检查（check-links.mjs）在 dist/server/.dev.vars 缺失时也用它：Turbo 缓存刻意不保存
 * .dev.vars（apps/web/turbo.json），缓存命中恢复的产物里没有这个文件。结果只写入已忽略的 dist，不进入提交。
 * 项目插件用 `mergeDevVars(base, overrides)` 添加或覆盖变量，因为空密钥已自动填值，直接追加会产生重复键。
 */
export function fallbackDevVars(root = WEB_ROOT): string | null {
  const example = join(root, '.dev.vars.example')
  if (!existsSync(example)) return null
  let source = readFileSync(example, 'utf8').replace(
    /^([A-Z0-9_]+)=[ \t]*$/gm,
    (line, key: string) => {
      const authDefault = previewAuthDefaults[key]
      if (authDefault) return `${key}=${authDefault}`
      if (key.endsWith('_SECRET') || key.endsWith('_TOKEN')) {
        return `${key}=${randomBytes(32).toString('base64')}`
      }
      return line
    },
  )
  const local = join(root, '.dev.vars')
  if (existsSync(local)) source = mergeDevVars(source, readFileSync(local, 'utf8'))
  if (process.env.APP_URL) source = mergeDevVars(source, `APP_URL=${process.env.APP_URL}`)
  return source
}

/**
 * 项目插件用此函数添加或覆盖 preview 变量。已有键保留首次出现的位置，同一键以最后赋值为准，
 * `overrides` 优先于 `base`，新键追加到末尾。
 */
export function mergeDevVars(base: string, overrides: string): string {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/
  const newline = base.includes('\r\n') ? '\r\n' : '\n'
  const lines: string[] = []
  const positions = new Map<string, number>()
  for (const line of base.split(/\r?\n/)) {
    const key = assignment.exec(line)?.[1]
    const position = key ? positions.get(key) : undefined
    if (position !== undefined) lines[position] = line
    else {
      if (key) positions.set(key, lines.length)
      lines.push(line)
    }
  }

  const extra = new Map<string, string>()
  for (const line of overrides.split(/\r?\n/)) {
    const key = assignment.exec(line)?.[1]
    if (!key) continue
    const position = positions.get(key)
    if (position !== undefined) lines[position] = line
    else extra.set(key, line)
  }
  const merged = lines.join(newline)
  if (extra.size === 0) return merged
  return `${merged.replace(/(?:\r?\n)*$/, newline)}${[...extra.values()].join(newline)}${newline}`
}

export function prerenderEnvFallback(root = WEB_ROOT): Plugin {
  return {
    name: 'saas:prerender-env-fallback',
    apply: 'build',
    enforce: 'post',
    applyToEnvironment: (environment) => environment.name === 'ssr',
    generateBundle(_options, bundle) {
      if ('.dev.vars' in bundle) {
        const asset = bundle['.dev.vars']
        if (process.env.APP_URL && asset.type === 'asset') {
          asset.source = String(asset.source).replace(
            /^APP_URL=.*$/m,
            `APP_URL=${process.env.APP_URL}`,
          )
        }
        return
      }
      const source = fallbackDevVars(root)
      if (source !== null) this.emitFile({ type: 'asset', fileName: '.dev.vars', source })
    },
  }
}
