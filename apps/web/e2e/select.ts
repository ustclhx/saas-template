import { expect, type Locator } from '@playwright/test'

/**
 * 在 `@saas/ui` 的 Select 中选择一项（替代原生 `<select>` 的 `selectOption`）。
 *
 * - `trigger` 用可访问名称定位：`form.getByRole('combobox', { name: 'Pricing mode', exact: true })`
 * - `option` 传选项文字（可访问名称）；数据驱动的验收脚本只有取值时传 `{ value }`，按 SelectItem 的
 *   `data-value` 匹配（空值选项按页面约定的占位值传，如 `'default'`）
 *
 * 触发器在水合前或 fieldset 禁用时不可点击，click 会等待其可用。选中后弹层有约 300ms 的确认动画，
 * 期间 Radix 屏蔽页面其余指针事件，所以等列表移除后再返回。
 */
export async function chooseOption(trigger: Locator, option: string | { value: string }) {
  const page = trigger.page()
  await trigger.click()
  const listbox = page.getByRole('listbox')
  const item =
    typeof option === 'string'
      ? listbox.getByRole('option', { name: option, exact: true })
      : listbox.locator(`[role="option"][data-value="${option.value}"]`)
  await item.click()
  await expect(listbox).toHaveCount(0)
}
