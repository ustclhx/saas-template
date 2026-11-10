import { log } from '@saas/shared/log'
import { getProjectHtmlAttributes } from './html-attributes.ts'
import type { HtmlAttributesContext } from './html-attributes.types.ts'

/** 在项目扩展边界过滤属性，避免事件处理器、模板属性或不可序列化值进入文档。 */
export function resolveHtmlAttributes(context: HtmlAttributesContext): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const [name, value] of Object.entries(getProjectHtmlAttributes(context))) {
    const allowed =
      typeof value === 'string' &&
      ((name !== 'data-preset' && /^data-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) ||
        name === 'title' ||
        (name === 'dir' && ['ltr', 'rtl', 'auto'].includes(value)) ||
        (name === 'translate' && ['yes', 'no'].includes(value)))
    if (!allowed) {
      log.warn('theme.html_attribute_ignored', { attribute: name })
      continue
    }
    attributes[name] = value
  }
  return attributes
}
