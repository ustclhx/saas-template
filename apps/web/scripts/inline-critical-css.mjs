// 构建后把预渲染页面引用的应用样式表内联进 HTML（LCP 优化，docs/runbooks/launch-v1.md 2.3）。
// 样式表是阻塞首绘的请求，首屏文字要等它下载完成；与同时加载的脚本抢带宽时可慢 1 秒以上。
// 样式表文件保留不删：Worker 动态渲染的页面仍引用它。
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = new URL('../dist/client/', import.meta.url).pathname

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* htmlFiles(path)
    else if (entry.name.endsWith('.html')) yield path
  }
}

// `<link rel="stylesheet" href="/assets/xxx.css">`，属性顺序不限，只处理本站 assets 下的样式表
const LINK = /<link\b[^>]*\brel="stylesheet"[^>]*>/g
const HREF = /\bhref="(\/assets\/[^"]+\.css)"/

const sheets = new Map()
const sheet = async (href) => {
  if (!sheets.has(href)) sheets.set(href, await readFile(join(root, href), 'utf8'))
  return sheets.get(href)
}

let pages = 0
let inlined = 0
for await (const file of htmlFiles(root)) {
  const html = await readFile(file, 'utf8')
  const links = [...html.matchAll(LINK)].filter((m) => HREF.test(m[0]))
  if (links.length === 0) continue
  let out = html
  for (const [tag] of links) {
    const href = tag.match(HREF)[1]
    const css = await sheet(href)
    if (css.includes('</style')) throw new Error(`${href} 含有 </style>，无法内联`)
    // 用函数替换，避免 CSS 中的 `$&`、`$'` 等被当作替换模式
    out = out.replace(tag, () => `<style>${css}</style>`)
    inlined += 1
  }
  await writeFile(file, out)
  pages += 1
}

if (pages === 0) throw new Error('未找到可内联样式表的 HTML，检查构建产物')
console.log(
  `inline-critical-css: ${inlined} 处内联，${pages} 个 HTML（${relative(process.cwd(), root)}）`,
)
