import type { HtmlAttributesContext, ProjectHtmlAttributes } from './html-attributes.types.ts'

/**
 * 项目自有扩展点：模板创建后不再修改此文件，生成器原样复制。
 * 根据服务端 host、locale、pathname 返回 data-* 或 dir/title/translate；
 * lang 与 data-preset 由模板维护，不可覆盖。多站点可返回 { 'data-site': 'east' }，
 * 配合 brand.css 的 :root[data-site="east"] 选择器覆盖品牌 token。
 * 保持同步且无副作用；预渲染会使用构建请求的 host，按域名分站时应分别构建或使用 SSR。
 */
export function getProjectHtmlAttributes(_context: HtmlAttributesContext): ProjectHtmlAttributes {
  return {}
}
