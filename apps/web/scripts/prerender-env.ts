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

/**
 * 由 .dev.vars.example 生成的本地 preview 变量（签名密钥随机生成）；没有示例文件时返回 null。
 * 构建后链接图检查（check-links.mjs）在 dist/server/.dev.vars 缺失时也用它：Turbo 缓存刻意不保存
 * .dev.vars（apps/web/turbo.json），缓存命中恢复的产物里没有这个文件。
 */
export function fallbackDevVars(root = WEB_ROOT): string | null {
  const example = join(root, '.dev.vars.example')
  if (!existsSync(example)) return null
  let source = readFileSync(example, 'utf8').replace(
    /^BETTER_AUTH_SECRET=.*$/m,
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64')}`,
  )
  if (process.env.APP_URL)
    source = source.replace(/^APP_URL=.*$/m, `APP_URL=${process.env.APP_URL}`)
  return source
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
