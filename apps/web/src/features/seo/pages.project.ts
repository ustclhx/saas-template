import type { TemplateConfig } from '@saas/config'
import type { SeoPage } from './metadata.ts'

/**
 * 项目自有的公开页面注册入口（openspec seo-internal-linking design 决策 1）。
 * 模板首次交付后本文件归项目所有，template-sync 不再覆盖。
 *
 * 在这里返回项目新增的公开页面（程序化详情页、hub 列表等），与模板页面清单合并后进入站点地图、
 * 分享图与内链校验。每个可索引页面需要 `titleMain`，除首页外需要 `parent`，且 parent、group、
 * related 指向的页面也要出现在清单中；校验在构建时执行，失败信息给出页面地址。例如：
 *
 *   // 模板库：/templates 是 hub，每个模板详情页属于一个分类（分类页同时是同组区块的 group）
 *   return templates.map((item) => ({
 *     path: `/templates/${item.slug}`,
 *     locale,
 *     title: item.title[locale],
 *     description: item.summary[locale],
 *     titleMain: item.name[locale],
 *     parent: `/templates/${item.category}`,
 *     group: `/templates/${item.category}`,
 *   }))
 *
 * `/templates` 与各分类页同样要返回条目（分类页 parent 为 /templates），页面本身由 routes/ 下的路由渲染；
 * 详情页的系列上一篇／下一篇在 template.config.ts 的 `seo.linking.series` 中按 group 声明。
 * 只有部分语言有译文的页面，缺失语言的条目写 `sourceLocale: <原语言>`（canonical 指向原语言、不进站点地图）。
 */
export function projectPages(_context: {
  /** 当前生成的语言 */
  locale: string
  defaultLocale: string
  now: Date
  config: TemplateConfig
}): SeoPage[] {
  return []
}
