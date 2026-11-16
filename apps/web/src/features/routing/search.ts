// 路由 search 参数校验，不依赖 zod。路由定义里的 validateSearch 不随页面组件拆分，
// 会进入水合时立即加载的路由树分包；在这里用 zod 会把整套 zod（约 35KB gzip）带进每个页面的首屏水合。
// 默认 parseSearch 会把 `?error=123`、`?canceled=true` 解析成数字与布尔值，这里统一转回字符串。

/** 可选字符串参数：数字与布尔值转为字符串，其他类型或超过 max 时视为未提供 */
export function optionalString(value: unknown, max = 2048): string | undefined {
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  return typeof text === 'string' && text.length <= max ? text : undefined
}

/** 可选枚举参数：不在 options 中时视为未提供 */
export function optionalEnum<const T extends string>(
  value: unknown,
  options: readonly T[],
): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 必填 UUID 参数：不合法时抛错，由路由的错误边界处理（与此前 zod 校验失败的行为一致） */
export function requiredUuid(value: unknown, name: string): string {
  if (typeof value === 'string' && UUID.test(value)) return value
  throw new Error(`Invalid search parameter: ${name}`)
}

/** 去掉值为 undefined 的键，返回可选键类型（与 zod 的 `.optional()` 输出一致，链接处可以不传这些参数） */
export function compactSearch<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}
