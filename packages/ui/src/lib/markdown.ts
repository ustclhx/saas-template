// 长文阅读器的 Markdown 安全与目录工具（openspec add-ui-design-system tasks 8.4，design D11）。
// 与渲染组件分开：聊天消息以后复用同一套白名单与链接规则。
import type { Element, Nodes as HastNodes, Root as HastRoot } from 'hast'
import type { Nodes as MdastNodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export interface ReaderHeading {
  /** 标题元素的 id，也是目录链接的锚点 */
  readonly id: string
  readonly text: string
  /** 只收集二级与三级标题 */
  readonly level: 2 | 3
}

/**
 * 允许渲染的元素白名单（GFM 子集）。原始 HTML 另由 `skipHtml` 丢弃，这里再兜一层：
 * 白名单之外的元素即使出现在语法树里也不会渲染，元素上也只会有 Markdown 语法能产生的属性。
 */
export const MARKDOWN_ALLOWED_ELEMENTS: readonly string[] = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  'a',
  'img',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // GFM 任务列表（禁用的复选框）与脚注
  'input',
  'sup',
  'section',
]

const SCHEME = /^([a-z][a-z\d+.-]*):/i
// 浏览器解析 URL 时会去掉前导控制字符与空格，并删除任意位置的制表符和换行（`java\tscript:` 仍是脚本协议）
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要匹配并去掉控制字符
const LEADING_CONTROL = /^[\u0000- ]+/
const TAB_OR_NEWLINE = /[\t\n\r]/g

/**
 * 链接与图片地址的协议白名单：只允许 http、https 与站内地址（相对路径、`/`、`#`、`?` 开头）。
 * 其余协议（`javascript:`、`data:`、`vbscript:`、`file:` 等）返回空串，渲染层把它当作「无链接」处理。
 */
export function safeMarkdownUrl(url: string): string {
  const normalized = url.replace(LEADING_CONTROL, '').replace(TAB_OR_NEWLINE, '')
  const scheme = SCHEME.exec(normalized)
  if (!scheme) {
    // 没有协议：站内相对地址。`\\host` 在部分浏览器中等同 `//host`，一并当作外链处理前先规范成 `//`
    return normalized.startsWith('\\') ? normalized.replace(/^\\+/, '//') : normalized
  }
  const protocol = scheme[1]?.toLowerCase()
  return protocol === 'http' || protocol === 'https' ? normalized : ''
}

/** 绝对 http(s) 地址或协议相对地址（`//host`）视为外链，新窗口打开并带 `rel="noopener noreferrer"` */
export function isExternalUrl(url: string): boolean {
  return /^(?:https?:|\/\/)/i.test(url)
}

export type MarkdownImagePolicy = 'all' | 'same-origin' | 'none'

/**
 * 图片地址是否按策略放行（地址已经过 `safeMarkdownUrl`）：`all` 允许 http(s) 与站内地址；
 * `same-origin` 只允许站内相对地址（不含 `//host`），服务端与客户端判定一致、不依赖当前域名；`none` 不显示图片。
 */
export function isAllowedImage(src: string, policy: MarkdownImagePolicy): boolean {
  if (!src || policy === 'none') return false
  if (policy === 'all') return true
  return !SCHEME.test(src) && !src.startsWith('//')
}

function textOf(node: MdastNodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node) return node.children.map(textOf).join('')
  return ''
}

function hastText(node: HastNodes): string {
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map((child) => hastText(child as HastNodes)).join('')
  return ''
}

/** 标题文字转为锚点：保留各语言的字母与数字，其余字符折叠为 `-`；加前缀避免与页面已有 id 冲突 */
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `section-${slug || 'untitled'}`
}

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * 正文中每个二、三级标题（按出现顺序，含空标题）的 id 与文字。id 去重时逐个尝试 `-2`、`-3`… 直到不与已有 id 冲突
 * （`## foo` 两次再加 `## foo 2` 也不会重复）。脚注定义里的标题不计入：渲染时它们在文末的脚注区，不参与目录。
 */
export function extractHeadingSlots(markdown: string): ReaderHeading[] {
  const tree = parser.parse(markdown)
  const used = new Set<string>()
  const headings: ReaderHeading[] = []
  function walk(node: MdastNodes) {
    if (node.type === 'footnoteDefinition') return
    if (node.type === 'heading') {
      if (node.depth === 2 || node.depth === 3) {
        const text = textOf(node).trim()
        const base = slugify(text)
        let id = base
        for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`
        used.add(id)
        headings.push({ id, text, level: node.depth })
      }
      return
    }
    if ('children' in node) for (const child of node.children) walk(child as MdastNodes)
  }
  walk(tree)
  return headings
}

/** 目录：二、三级标题中文字非空的项 */
export function extractHeadings(markdown: string): ReaderHeading[] {
  return extractHeadingSlots(markdown).filter((heading) => heading.text !== '')
}

/**
 * rehype 插件：按出现顺序把 `extractHeadingSlots` 的 id 写到正文的 h2 / h3 上，跳过文末脚注区
 * （`section[data-footnotes]`，其中的「脚注」标题由 remark-rehype 生成）。两边解析同一份源文、同一组语法扩展，
 * 顺序一致；原始 HTML 里的标题已被 skipHtml 丢弃，不参与计数。
 * 传入 `title` 时，正文开头与标题相同的一级标题会被去掉（阅读器已在正文前显示标题）。
 */
export function rehypeHeadingIds(slots: readonly ReaderHeading[], title?: string) {
  return () => (tree: HastRoot) => {
    if (title) {
      const first = tree.children.findIndex((child) => child.type === 'element')
      const node = tree.children[first]
      if (
        node?.type === 'element' &&
        node.tagName === 'h1' &&
        hastText(node).trim() === title.trim()
      ) {
        tree.children.splice(first, 1)
      }
    }
    let index = 0
    function walk(node: HastNodes) {
      if (node.type === 'element') {
        if (node.tagName === 'section' && node.properties.dataFootnotes !== undefined) return
        if (node.tagName === 'h2' || node.tagName === 'h3') {
          const heading = slots[index]
          index += 1
          if (heading) (node as Element).properties.id = heading.id
          return
        }
      }
      if ('children' in node) for (const child of node.children) walk(child as HastNodes)
    }
    walk(tree)
  }
}
