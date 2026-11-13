// 首页包检查（openspec add-ui-design-system tasks 8.4 评审 B1）：从预渲染首页 dist/client/index.html 引用的脚本出发，
// 沿静态 import（不含动态 import()）求闭包，确认其中没有长文阅读器与 Markdown 解析代码。
// 只看 index.html 直接列出的文件不够：路由文件中未被拆分的部分（如 validateSearch）会让入口静态导入重的分包。
// add-og-images 5.5：服务端（Worker 入口与首页路由分包）与客户端首页闭包都不得出现分享卡片渲染器、
// satori、resvg 与字体；渲染器只能经动态 import() 在分享卡片路由中加载。
// 用法：node scripts/check-home-bundle.mjs [dist/client] [dist/server]；`pnpm build` 在预渲染后自动执行。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

/**
 * 首页不应出现的代码特征：mdast-util-to-hast 的 id 前缀、GFM 脚注区属性、阅读器自身的标记、
 * 对话 Markdown 代码块的标记（`@saas/ui/chat`，add-ai-chat-components 3.4）
 */
export const FORBIDDEN_MARKERS = [
  'user-content-',
  'data-footnotes',
  'reader-mobile-toc',
  'data-chat-code',
]

/** 分享卡片渲染器的代码特征：cf-workers-og、satori、resvg 的 WASM 初始化与 CJK 字体文件名 */
export const RENDERER_MARKERS = [
  'cf-workers-og',
  'satori',
  'resvg',
  'initWasm',
  'NotoSansSC-Regular',
]

// 静态导入的 WASM、Data 模块与字体文件（渲染器随包的部分）
const BINARY_IMPORT =
  /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"']+\.(?:wasm|bin|woff2?|otf|ttf))["']/g

// 压缩后的静态导入 / 再导出：`import{a}from"./x.js"`、`import"./x.js"`、`export*from"./x.js"`；
// `import("./x.js")` 的引号前是括号，不匹配
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"']+\.js)["']/g
const HTML_SCRIPT = /["'](\/assets\/[^"']+\.js)["']/g

/** 首页 HTML 中出现的全部本站脚本（script src、modulepreload 与内联引导脚本里的路径） */
export function htmlScripts(html) {
  return [...new Set([...html.matchAll(HTML_SCRIPT)].map((match) => match[1]))]
}

/** 从入口脚本（以 `/assets/...` 表示）出发的静态 import 闭包 */
export function staticClosure(clientDir, entries) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const asset = queue.shift()
    if (seen.has(asset)) continue
    const file = join(clientDir, asset)
    if (!existsSync(file)) continue
    seen.add(asset)
    const code = readFileSync(file, 'utf8')
    for (const [, specifier] of code.matchAll(STATIC_IMPORT)) {
      if (/^[a-z]+:/i.test(specifier)) continue
      const next = specifier.startsWith('/')
        ? specifier
        : posix.join(posix.dirname(asset), specifier)
      if (!seen.has(next)) queue.push(next)
    }
  }
  return [...seen]
}

function scan(dir, files, markers) {
  const violations = []
  let gzipBytes = 0
  for (const asset of files) {
    const code = readFileSync(join(dir, asset))
    gzipBytes += gzipSync(code, { level: 9 }).length
    const text = code.toString('utf8')
    for (const marker of markers) {
      if (text.includes(marker)) violations.push({ asset, marker })
    }
    for (const [, specifier] of text.matchAll(BINARY_IMPORT)) {
      violations.push({ asset, marker: specifier })
    }
  }
  return { gzipBytes, violations }
}

export function checkHomeBundle(clientDir) {
  const html = readFileSync(join(clientDir, 'index.html'), 'utf8')
  const files = staticClosure(clientDir, htmlScripts(html))
  return { files, ...scan(clientDir, files, [...FORBIDDEN_MARKERS, ...RENDERER_MARKERS]) }
}

/**
 * 服务端首页闭包：Worker 入口 index.js 加上首页路由（src/routes/index.tsx 的各拆分分包）的静态 import 闭包，
 * 分包位置取自 Vite manifest（dist/server/.vite/manifest.json）。
 */
export function checkServerHomeBundle(serverDir) {
  const manifestPath = join(serverDir, '.vite/manifest.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
  const routeEntries = Object.entries(manifest)
    .filter(([source]) => /^src\/routes\/index\.tsx(?:\?|$)/.test(source))
    .map(([, chunk]) => `/${chunk.file}`)
  const files = staticClosure(serverDir, ['/index.js', ...routeEntries])
  return { files, routeEntries, ...scan(serverDir, files, RENDERER_MARKERS) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const clientDir = resolve(process.argv[2] ?? join(dirname(process.argv[1]), '../dist/client'))
  const serverDir = resolve(process.argv[3] ?? join(clientDir, '../server'))
  const { files, gzipBytes, violations } = checkHomeBundle(clientDir)
  // 唯一调用方是 `pnpm build`（Cloudflare 构建，必有 dist/server）；缺少服务端产物时失败，避免静默跳过
  const server = existsSync(join(serverDir, 'index.js')) ? checkServerHomeBundle(serverDir) : null
  if (!server) {
    console.error(`首页包检查失败：找不到服务端产物 ${join(serverDir, 'index.js')}`)
    process.exitCode = 1
  } else if (server.routeEntries.length === 0) {
    console.error('首页包检查失败：服务端 manifest 中找不到首页路由分包（src/routes/index.tsx）')
    process.exitCode = 1
  }
  if (violations.length > 0 || (server?.violations.length ?? 0) > 0) {
    console.error(
      '首页包检查失败：首页静态依赖中出现了只应懒加载的代码（阅读器 / 对话 / Markdown / 分享卡片渲染器与字体）',
    )
    for (const { asset, marker } of violations) console.error(`  - 客户端 ${asset} 含 "${marker}"`)
    for (const { asset, marker } of server?.violations ?? [])
      console.error(`  - 服务端 ${asset} 含 "${marker}"`)
    process.exitCode = 1
  } else if (process.exitCode !== 1) {
    console.log(`首页包检查通过：${files.length} 个脚本，gzip 合计 ${gzipBytes} B`)
    console.log(`服务端首页闭包检查通过：${server?.files.length} 个模块`)
  }
}
