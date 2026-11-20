import type { UntranslatedMode } from '@saas/config'
import { templateConfig } from '../../server/template-config.ts'
import { isFallbackPage, localizedPath, pageAlternates, type SeoPage } from './metadata.ts'

export interface SeoPagesReport {
  /** 失败级：构建必须中止 */
  readonly errors: string[]
  /** 警告级：只输出，不影响构建 */
  readonly warnings: string[]
}

const hint =
  '内容页可在 frontmatter 写 parent／related 覆盖，项目页面在 apps/web/src/features/seo/pages.project.ts 注册'

/**
 * 页面清单的静态校验（openspec seo-internal-linking tasks.md 1.5），在构建时对 `publicPages()` 的结果执行：
 * - 同一语言内地址唯一；
 * - 可索引的真实页面（非回退页）必须有 `titleMain`，除首页外必须有 `parent`；
 * - `parent`、`group`、`related` 指向同一语言中存在且可索引的页面，parent 链不能成环；
 * - 主词重复只警告；
 * - `'hide'` 模式下不能有回退页（openspec multilingual-seo 3.1）；
 * - `alternates`（multilingual-seo 3.2）：键必须是已配置语言，各语言版本在清单中存在、可索引，并声明同一组地址；
 *   同路径的其他语言页面也必须声明 alternates，否则两边的 hreflang 无法互指。
 * 回退页沿用原语言页的声明，`indexable: false` 的页面不参与检查，但仍不能作为上述字段的目标。
 */
export function validateSeoPages(
  pages: readonly SeoPage[],
  options: { locales?: readonly string[]; untranslated?: UntranslatedMode } = {},
): SeoPagesReport {
  const { i18n } = templateConfig
  const locales = options.locales ?? (i18n.enabled ? i18n.locales : [i18n.defaultLocale])
  const untranslated = options.untranslated ?? i18n.untranslated
  const errors: string[] = []
  const warnings: string[] = []
  const byLocale = new Map<string, SeoPage[]>()
  for (const page of pages) byLocale.set(page.locale, [...(byLocale.get(page.locale) ?? []), page])

  for (const [locale, list] of byLocale) {
    const url = (path: string) => localizedPath(path, locale)
    const byPath = new Map<string, SeoPage>()
    for (const page of list) {
      if (byPath.has(page.path)) errors.push(`${url(page.path)}: 同一语言中地址重复，url 必须唯一`)
      else byPath.set(page.path, page)
    }

    const target = (page: SeoPage, field: string, path: string) => {
      const found = byPath.get(path)
      if (!found)
        errors.push(`${url(page.path)}: ${field} 指向不存在的页面 ${url(path)}（${hint}）`)
      else if (found.indexable === false)
        errors.push(`${url(page.path)}: ${field} 指向不可索引的页面 ${url(path)}`)
    }

    const mains = new Map<string, string[]>()
    for (const page of byPath.values()) {
      if (page.indexable === false || isFallbackPage(page)) continue
      const main = page.titleMain?.trim()
      if (!main) errors.push(`${url(page.path)}: 缺少 titleMain（主词）`)
      else mains.set(main, [...(mains.get(main) ?? []), url(page.path)])
      if (page.path === '/') {
        if (page.parent !== undefined) errors.push(`${url(page.path)}: 首页不能声明 parent`)
      } else if (page.parent === undefined) {
        errors.push(`${url(page.path)}: 缺少 parent（${hint}）`)
      } else if (page.parent === page.path) {
        errors.push(`${url(page.path)}: parent 不能指向自身`)
      } else {
        target(page, 'parent', page.parent)
      }
      if (page.group !== undefined) target(page, 'group', page.group)
      for (const related of page.related ?? []) {
        if (related === page.path) errors.push(`${url(page.path)}: related 不能包含自身`)
        else target(page, 'related', related)
      }
    }

    // parent 链必须终止（到首页或缺失的上级，缺失已单独报告），成环时面包屑无法生成
    for (const page of byPath.values()) {
      if (page.parent === page.path) continue // 指向自身已单独报告
      const seen = new Set([page.path])
      let parent = page.parent
      while (parent !== undefined && parent !== page.path) {
        if (seen.has(parent)) break
        seen.add(parent)
        parent = byPath.get(parent)?.parent
      }
      if (parent === page.path) errors.push(`${url(page.path)}: parent 链成环`)
    }

    for (const [main, urls] of mains)
      if (urls.length > 1) warnings.push(`主词「${main}」在 ${locale} 中重复：${urls.join('、')}`)
  }

  if (untranslated === 'hide')
    for (const page of pages)
      if (page.indexable !== false && isFallbackPage(page))
        errors.push(
          `${localizedPath(page.path, page.locale)}: 缺少译文的回退页（sourceLocale ${page.sourceLocale}）在 i18n.untranslated 为 'hide' 时不发布，删除该条目或改用 'fallback'`,
        )
  errors.push(...validateAlternates(pages, locales))
  return { errors, warnings }
}

/** alternates 的语言合法性与双向声明（hreflang 组必须在每个成员上完全一致） */
function validateAlternates(pages: readonly SeoPage[], locales: readonly string[]): string[] {
  const errors: string[] = []
  const find = (locale: string, path: string) =>
    pages.find((page) => page.locale === locale && page.path === path)
  const describe = (group: Record<string, string>) =>
    Object.keys(group)
      .sort()
      .map((locale) => `${locale}=${group[locale]}`)
      .join(', ')
  for (const page of pages) {
    const group = pageAlternates(page)
    if (!group || page.indexable === false || isFallbackPage(page)) continue
    const url = localizedPath(page.path, page.locale)
    for (const [locale, path] of Object.entries(page.alternates ?? {})) {
      if (!locales.includes(locale)) {
        errors.push(`${url}: alternates 的键 ${locale} 不是已配置的语言（i18n.locales）`)
        continue
      }
      if (locale === page.locale) {
        if (path !== page.path)
          errors.push(`${url}: alternates.${locale} 必须是本页地址 ${page.path}`)
        continue
      }
      const target = find(locale, path)
      const targetUrl = localizedPath(path, locale)
      if (!target) {
        errors.push(`${url}: alternates.${locale} 指向不存在的页面 ${targetUrl}`)
        continue
      }
      if (target.indexable === false || isFallbackPage(target)) {
        errors.push(`${url}: alternates.${locale} 指向不可索引的页面 ${targetUrl}`)
        continue
      }
      const reverse = pageAlternates(target)
      if (reverse?.[page.locale] !== page.path)
        errors.push(
          `${url}: alternates.${locale} 指向的 ${targetUrl} 没有反向声明 ${page.locale}=${page.path}`,
        )
      else if (describe(reverse) !== describe(group))
        errors.push(
          `${url}: 与 ${targetUrl} 声明的语言版本不一致（${describe(group)} ≠ ${describe(reverse)}）`,
        )
    }
    // 同路径的其他语言页未声明 alternates 时会按同路径关联到本页，而本页不一定列出它
    for (const other of pages)
      if (
        other.path === page.path &&
        other.locale !== page.locale &&
        other.alternates === undefined &&
        other.indexable !== false &&
        !isFallbackPage(other)
      )
        errors.push(
          `${localizedPath(other.path, other.locale)}: 同路径的 ${url} 声明了 alternates，本页也需声明`,
        )
  }
  return errors
}

/** 构建时调用：输出警告，存在失败级问题时抛错（错误信息逐行列出页面地址）。 */
export function assertSeoPages(
  pages: readonly SeoPage[],
  warn: (message: string) => void = console.warn,
): void {
  const { errors, warnings } = validateSeoPages(pages)
  for (const warning of warnings) warn(`[seo] ${warning}`)
  if (errors.length)
    throw new Error(`公开页面元数据校验失败（${errors.length} 项）：\n${errors.join('\n')}`)
}
