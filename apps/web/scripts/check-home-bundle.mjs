// 首页包检查（openspec add-ui-design-system tasks 8.4 评审 B1）：从预渲染首页 dist/client/index.html 引用的脚本出发，
// 沿静态 import（不含动态 import()）求闭包，确认其中没有长文阅读器与 Markdown 解析代码。
// 只看 index.html 直接列出的文件不够：路由文件中未被拆分的部分（如 validateSearch）会让入口静态导入重的分包。
// 用法：node scripts/check-home-bundle.mjs [dist/client]；`pnpm build` 在预渲染后自动执行。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

/** 首页不应出现的代码特征：mdast-util-to-hast 的 id 前缀、GFM 脚注区属性、阅读器自身的标记 */
export const FORBIDDEN_MARKERS = ['user-content-', 'data-footnotes', 'reader-mobile-toc']

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

export function checkHomeBundle(clientDir) {
  const html = readFileSync(join(clientDir, 'index.html'), 'utf8')
  const files = staticClosure(clientDir, htmlScripts(html))
  const violations = []
  let gzipBytes = 0
  for (const asset of files) {
    const code = readFileSync(join(clientDir, asset))
    gzipBytes += gzipSync(code, { level: 9 }).length
    const text = code.toString('utf8')
    for (const marker of FORBIDDEN_MARKERS) {
      if (text.includes(marker)) violations.push({ asset, marker })
    }
  }
  return { files, gzipBytes, violations }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const clientDir = resolve(process.argv[2] ?? join(dirname(process.argv[1]), '../dist/client'))
  const { files, gzipBytes, violations } = checkHomeBundle(clientDir)
  if (violations.length > 0) {
    console.error('首页包检查失败：首页静态依赖中出现了只应懒加载的代码（阅读器 / Markdown）')
    for (const { asset, marker } of violations) console.error(`  - ${asset} 含 "${marker}"`)
    process.exitCode = 1
  } else {
    console.log(`首页包检查通过：${files.length} 个脚本，gzip 合计 ${gzipBytes} B`)
  }
}
