import { uiPresets } from '@saas/config'
import { UI_PRESETS } from '@saas/ui'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'

// HeadContent / Scripts 依赖路由上下文，这里只关心 <html> 与 <body> 外壳
vi.mock('@tanstack/react-router', () => ({ HeadContent: () => null, Scripts: () => null }))

import { RootDocument } from './root-document.tsx'

describe('根布局外壳', () => {
  it('服务端输出 data-preset，取自 template.config.ts 的 ui.preset', () => {
    const html = renderToString(
      <RootDocument floatingControls={false}>
        <main>content</main>
      </RootDocument>,
    )
    expect(html).toMatch(new RegExp(`<html[^>]*data-preset="${templateConfig.ui.preset}"`))
    expect(html).toContain('<main>content</main>')
  })

  it('预设名单只有一个来源：配置校验与组件包一致，当前预设在名单内', () => {
    expect([...uiPresets]).toEqual([...UI_PRESETS])
    expect(UI_PRESETS).toContain(templateConfig.ui.preset)
  })
})
