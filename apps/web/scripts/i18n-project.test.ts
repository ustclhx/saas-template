import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@inlang/paraglide-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  findMissingMessages,
  formatMissingMessages,
  paraglideOptions,
  writeInlangProject,
} from './i18n-project.ts'

const i18n = { locales: ['en', 'zh'], defaultLocale: 'en' }
let root: string

function writeMessages(locale: string, feature: string, messages: Record<string, string>) {
  mkdirSync(join(root, 'messages', locale), { recursive: true })
  writeFileSync(join(root, 'messages', locale, `${feature}.json`), JSON.stringify(messages))
}

// 临时的 apps/web 结构：中文 common.json 删掉了一条文案
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'saas-i18n-'))
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
  writeMessages('en', 'common', { common_save: 'Save', common_cancel: 'Cancel' })
  writeMessages('zh', 'common', { common_save: '保存' })
  writeMessages('en', 'pricing', { pricing_title: 'Pricing' })
  writeMessages('zh', 'pricing', { pricing_title: '定价' })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('文案回退与缺失检查（tasks.md 1.3）', () => {
  it('缺失检查以默认语言为准列出缺失项', () => {
    const missing = findMissingMessages(i18n, root)
    expect(missing).toEqual([{ locale: 'zh', feature: 'common', key: 'common_cancel' }])
    expect(formatMissingMessages(missing)).toContain('zh: common_cancel (messages/zh/common.json)')
    expect(formatMissingMessages([])).toBeNull()
  })

  it('按功能拆分的文案文件编译后，缺失的中文文案回退到默认语言文本而不是键名', async () => {
    writeInlangProject(i18n, root)
    await compile({ ...paraglideOptions([], root), emitTsDeclarations: false })
    const { m } = (await import(join(root, 'src/paraglide/messages.js'))) as {
      m: Record<string, (inputs?: object, options?: { locale: string }) => string>
    }
    expect(m.common_save?.({}, { locale: 'zh' })).toBe('保存')
    expect(m.pricing_title?.({}, { locale: 'zh' })).toBe('定价')
    expect(m.common_cancel?.({}, { locale: 'zh' })).toBe('Cancel')
  })
})
