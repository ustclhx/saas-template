import { describe, expect, it } from 'vitest'
import { optionalEnum, optionalString, requiredUuid } from './search.ts'

describe('路由 search 校验', () => {
  it('optionalString 接受字符串，数字与布尔值转为字符串，其他视为未提供', () => {
    expect(optionalString('x')).toBe('x')
    expect(optionalString(123)).toBe('123')
    expect(optionalString(true)).toBe('true')
    expect(optionalString(undefined)).toBeUndefined()
    expect(optionalString({ a: 1 })).toBeUndefined()
    expect(optionalString('a'.repeat(256), 255)).toBeUndefined()
  })

  it('optionalEnum 只接受列出的值', () => {
    expect(optionalEnum('stripe', ['stripe', 'paypal'])).toBe('stripe')
    expect(optionalEnum('other', ['stripe', 'paypal'])).toBeUndefined()
  })

  it('requiredUuid 不合法时抛错', () => {
    expect(requiredUuid('0195f3b2-6c1e-7d4a-9b2f-1a2b3c4d5e6f', 'id')).toBe(
      '0195f3b2-6c1e-7d4a-9b2f-1a2b3c4d5e6f',
    )
    expect(() => requiredUuid('nope', 'id')).toThrow('id')
  })
})
