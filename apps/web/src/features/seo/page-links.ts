import type { SeoLinkingConfig } from '@saas/config'
import type { SeoPage } from './metadata.ts'

/**
 * 公开页内链区块的数据（openspec seo-internal-linking tasks 3.1–3.3，design 决策 7）：面包屑、系列上一篇／下一篇、
 * 相关、同组。只在服务端（server function）或构建期按公开页面清单计算，结果随 loader 数据下发；
 * 页面清单与内容数据不进入客户端包。
 *
 * 地址都是不带语言前缀的 path：页面用路由 Link 渲染，由 localeRewrite 加上当前语言前缀。
 * 锚文本只取目标页的 `titleMain` 或 `anchorShort`（spec「锚文本来源」），不接受自由文本。
 */
export interface PageLink {
  href: string
  /** 目标页的 titleMain（面包屑优先 anchorShort） */
  label: string
}

export interface PageCardLink extends PageLink {
  description: string
}

export interface PageLinks {
  /** 从首页起的全部上级，按层级顺序；首页本身为空 */
  breadcrumb: PageLink[]
  /** 系列上一篇／下一篇；页面不属于声明的系列时为 null */
  series: { previous: PageLink | null; next: PageLink | null } | null
  /** 相关区块；未声明 related 时为空数组（不渲染） */
  related: PageCardLink[]
  /** 同组区块；未声明 group 时为 null（不渲染） */
  group: { key: string; hub: PageLink | null; items: PageLink[] } | null
}

export const emptyPageLinks: PageLinks = { breadcrumb: [], series: null, related: [], group: null }

/** hub 列表的分页地址：第 1 页即 hub 本身，第 n 页为 `<hub>/page/<n>` */
export function hubPagePath(hub: string, page: number): string {
  return page <= 1 ? hub : `${hub === '/' ? '' : hub}/page/${page}`
}

/** 分页地址中的页码：只接受不带前导零的十进制整数，其余返回 null（路由返回 404） */
export function parseHubPage(value: string): number | null {
  return /^[1-9]\d{0,4}$/.test(value) ? Number(value) : null
}

/** 页面的主词：titleMain，缺失时退回 title（校验会对可索引页报缺失） */
export function mainLabel(page: Pick<SeoPage, 'titleMain' | 'title'>): string {
  return page.titleMain ?? page.title
}

/** 面包屑用短变体：anchorShort 优先（如首页「Home」），否则主词 */
function crumbLabel(page: Pick<SeoPage, 'titleMain' | 'title' | 'anchorShort'>): string {
  return page.anchorShort ?? mainLabel(page)
}

/**
 * 沿 parent 链列出上级（首页在前）；遇到缺失或成环的上级时停止，静态校验会单独报告。
 * `parent` 省略时取清单中该页的声明。
 */
export function breadcrumbTrail(
  path: string,
  find: (path: string) => SeoPage | undefined,
  parentOf: string | undefined = find(path)?.parent,
): PageLink[] {
  const trail: PageLink[] = []
  const seen = new Set([path])
  let parent = parentOf
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent)
    const page = find(parent)
    if (!page) break
    trail.unshift({ href: page.path, label: crumbLabel(page) })
    parent = page.parent
  }
  return trail
}

const linkable = (page: SeoPage | undefined): page is SeoPage =>
  page !== undefined && page.indexable !== false

/** 系列排序：declared 按页面清单顺序，date 按发布时间升序，titleMain 按主词 */
function orderSeries(members: SeoPage[], orderBy: SeoLinkingConfig['series'][number]['orderBy']) {
  if (orderBy === 'declared') return members
  const sorted = [...members]
  if (orderBy === 'date') sorted.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  else sorted.sort((a, b) => mainLabel(a).localeCompare(mainLabel(b), a.locale))
  return sorted
}

/**
 * 计算一页的内链区块。`pages` 为公开页面清单（`publicPages()`，含全部语言），按 `locale` 取同语言页面。
 * 不在清单中的页面（如开发环境可访问的草稿）只按 `fallbackParent` 生成面包屑。
 * - 同组：同组其他页面最多 `groupLinksMax` 个，从本页之后依次取（到末尾回到开头），使组内每页都有入链；
 * - 系列：`seo.linking.series` 声明了本页 group 时输出上一篇／下一篇，第一页没有上一篇、最后一页没有下一篇。
 */
export function pageLinks(
  pages: readonly SeoPage[],
  path: string,
  locale: string,
  linking: Pick<SeoLinkingConfig, 'series' | 'groupLinksMax'>,
  fallbackParent?: string,
): PageLinks {
  const local = pages.filter((page) => page.locale === locale)
  const byPath = new Map(local.map((page) => [page.path, page]))
  const find = (target: string) => byPath.get(target)
  const page = byPath.get(path)
  if (!page) return { ...emptyPageLinks, breadcrumb: breadcrumbTrail(path, find, fallbackParent) }

  const related = (page.related ?? [])
    .map((target) => byPath.get(target))
    .filter(linkable)
    .filter((target) => target.path !== path)
    .map((target) => ({
      href: target.path,
      label: mainLabel(target),
      description: target.description,
    }))

  let group: PageLinks['group'] = null
  let series: PageLinks['series'] = null
  if (page.group !== undefined) {
    const key = page.group
    let members = local.filter((entry) => entry.group === key && linkable(entry))
    const declared = linking.series.find((entry) => entry.group === key)
    if (declared) {
      members = orderSeries(members, declared.orderBy)
      const index = members.findIndex((entry) => entry.path === path)
      const at = (offset: number): PageLink | null => {
        const target = index < 0 ? undefined : members[index + offset]
        return target ? { href: target.path, label: mainLabel(target) } : null
      }
      series = { previous: at(-1), next: at(1) }
    }
    // 系列已链接的上一篇／下一篇不在同组区块重复出现
    const shown = new Set([path, series?.previous?.href, series?.next?.href])
    const index = members.findIndex((entry) => entry.path === path)
    const picked = new Set(
      [...members.slice(index + 1), ...members.slice(0, Math.max(index, 0))]
        .filter((entry) => !shown.has(entry.path))
        .slice(0, linking.groupLinksMax),
    )
    const hub = byPath.get(key)
    group = {
      key,
      hub: linkable(hub) && hub.path !== path ? { href: hub.path, label: mainLabel(hub) } : null,
      // 按组内顺序列出
      items: members
        .filter((entry) => picked.has(entry))
        .map((entry) => ({ href: entry.path, label: mainLabel(entry) })),
    }
  }

  return {
    breadcrumb: breadcrumbTrail(path, find),
    series,
    related,
    group,
  }
}
