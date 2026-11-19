// 内容集合页面的默认上级（openspec seo-internal-linking design 决策 1）：frontmatter 的 `parent` 可覆盖。
// content-collections.ts 与公开页面清单共用；本文件不引入其他模块，内容构建时可直接加载。
export const contentParents = {
  posts: '/blog',
  docs: '/docs',
  guides: '/guides',
  legal: '/',
} as const

/** 站内地址：以 / 开头、不含协议与主机、不带查询参数与锚点（与 SeoPage.path 同一形式） */
export const sitePathPattern = /^\/(?!\/)[^?#\s]*$/
