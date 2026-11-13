import { shareCardThemes } from '@saas/ui/share-card-theme'
import type { ReactElement, ReactNode } from 'react'
import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { defaultShareCardLayout, sampleShareCardLayout, shareCardLayout } from './layout.tsx'
import { collectText } from './renderer.ts'
import { containsCjk, textWidth, truncateText } from './text.ts'
import { resolveShareCardTheme } from './theme.ts'

type Style = Record<string, unknown>
type Node = ReactElement<{ style?: Style; children?: ReactNode }>

/** 深度优先列出元素树中的全部元素。 */
function elements(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<{ style?: Style; children?: ReactNode }>(node)) return []
  return [node, ...elements(node.props.children)]
}

function withText(tree: ReactNode, text: string): Node {
  const found = elements(tree).find((node) => node.props.children === text)
  if (!found) throw new Error(`missing ${text}`)
  return found
}

const light = shareCardThemes.light
const zh = {
  title: '2026 年第三季度用户调研要点',
  description: '新用户留存提升 12%，主要来自引导流程简化；移动端满意度仍低于桌面端。',
  label: '报告摘要',
  meta: '5 条结论 · 3 个风险',
}

describe('分享卡片版式（4.2）', () => {
  it('示例类型用固定数据得到设计稿的版式树，颜色来自主题 token', () => {
    const tree = sampleShareCardLayout(zh, resolveShareCardTheme('light'))
    const root = tree as Node
    expect(root.props.style).toMatchObject({
      width: 1200,
      height: 630,
      display: 'flex',
      flexDirection: 'column',
      padding: '64px 72px',
      background: light.background,
      color: light.foreground,
    })
    expect(withText(tree, zh.title).props.style).toMatchObject({ fontSize: 60, fontWeight: 600 })
    expect(withText(tree, zh.description).props.style).toMatchObject({
      fontSize: 28,
      color: light.mutedForeground,
    })
    expect(withText(tree, zh.label).props.style).toMatchObject({
      height: 44,
      background: light.secondary,
      color: light.mutedForeground,
    })
    expect(withText(tree, 'M').props.style).toMatchObject({
      width: 52,
      borderRadius: light.radius + 4,
      background: light.primary,
      color: light.primaryForeground,
    })
    expect(withText(tree, 'example.com').props.style).toMatchObject({ color: light.foreground })
    const footer = elements(tree).find((node) => node.props.style?.borderTop)
    expect(footer?.props.style?.borderTop).toBe(`1px solid ${light.border}`)
    expect(elements(tree).some((node) => node.props.style?.background === light.brandAccent)).toBe(
      true,
    )
    expect(collectText(tree)).toContain(templateConfig.app.name)
  })

  it('深色主题替换全部颜色，没有写死的颜色', () => {
    const dark = shareCardThemes.dark
    const tree = sampleShareCardLayout(zh, resolveShareCardTheme('dark'))
    const allowed = new Set(Object.values(dark).filter((value) => typeof value === 'string'))
    for (const node of elements(tree)) {
      for (const key of ['background', 'color'] as const) {
        const value = node.props.style?.[key]
        if (value !== undefined) expect(allowed.has(value as string), `${key}: ${value}`).toBe(true)
      }
    }
    expect((tree as Node).props.style?.background).toBe(dark.background)
  })

  it('默认版式（构建期分享图）用大标题、无标签与摘要', () => {
    const tree = defaultShareCardLayout('定价与套餐', resolveShareCardTheme('light'))
    expect(withText(tree, '定价与套餐').props.style).toMatchObject({ fontSize: 76, maxHeight: 184 })
    expect(collectText(tree)).toContain(`${templateConfig.app.name} · AI workspace`)
    expect(elements(tree).some((node) => node.props.style?.height === 44)).toBe(false)
  })

  it('超长标题与摘要按字宽加权截断并以省略号结尾', () => {
    const long =
      '面向中小团队的跨部门协作流程梳理：从需求收集、优先级评估到交付复盘的完整实践记录与改进建议'
    const tree = shareCardLayout({ title: long, summary: long.repeat(2) }, light)
    const texts = elements(tree).map((node) => node.props.children)
    const title = texts.find((text) => typeof text === 'string' && text.startsWith('面向中小'))
    expect(title).toBe(`${[...long].slice(0, 27).join('')}…`)
    expect(textWidth(title as string)).toBeLessThanOrEqual(28)
  })
})

describe('字宽加权截断', () => {
  it('CJK 记 1、拉丁约 0.55', () => {
    expect(textWidth('中文')).toBe(2)
    expect(textWidth('ab')).toBeCloseTo(1.1)
    expect(containsCjk('Report 报告')).toBe(true)
    expect(containsCjk('Report')).toBe(false)
    expect(containsCjk('レポート')).toBe(true)
    expect(containsCjk('보고서')).toBe(true)
  })

  it('同样上限下英文能容纳更多字符', () => {
    const en = 'Q3 2026 user research highlights and next steps for the onboarding team'
    const cut = truncateText(en, 28)
    expect(cut.endsWith('…')).toBe(true)
    expect([...cut].length).toBeGreaterThan(40)
    expect(textWidth(cut)).toBeLessThanOrEqual(28)
    expect(truncateText('短标题', 28)).toBe('短标题')
    expect(truncateText('  多余   空白 ', 28)).toBe('多余 空白')
  })
})
