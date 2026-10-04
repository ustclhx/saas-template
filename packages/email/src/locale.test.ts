import { describe, expect, it } from 'vitest'
import { resolveEmailLocale } from './locale.ts'

describe('resolveEmailLocale', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh_Hant', 'zh'],
    [' ZH-tw ', 'zh'],
    ['fr', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('%j → %s', (input, expected) => {
    expect(resolveEmailLocale(input)).toBe(expected)
  })
})
