import { isFallbackPage, localizedPath, type SeoPage } from './metadata.ts'

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
 * - 主词重复只警告。
 * 回退页沿用原语言页的声明，`indexable: false` 的页面不参与检查，但仍不能作为上述字段的目标。
 */
export function validateSeoPages(pages: readonly SeoPage[]): SeoPagesReport {
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
  return { errors, warnings }
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
