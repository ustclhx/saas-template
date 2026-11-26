import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../src/index.ts'

afterEach(() => cleanup())

function MoreSettings({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger>更多设置</CollapsibleTrigger>
      <CollapsibleContent>
        <label>
          张数
          <input />
        </label>
      </CollapsibleContent>
    </Collapsible>
  )
}

describe('Collapsible（shadcn 结构补缺）', () => {
  it('服务端默认折叠：触发器 aria-expanded=false，不输出内容', () => {
    const html = renderToString(<MoreSettings />)
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('张数')
  })

  it('点击触发器展开并关联内容区，再次点击收起', () => {
    render(<MoreSettings />)
    const trigger = screen.getByRole('button', { name: '更多设置' })
    expect(trigger.className).toContain('focus-visible:outline-2')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const content = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(content?.dataset.state).toBe('open')
    expect(content?.className).toContain('motion-reduce:animate-none')
    expect(screen.getByLabelText('张数')).toBeTruthy()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('defaultOpen 时首屏即展开', () => {
    expect(renderToString(<MoreSettings defaultOpen />)).toContain('张数')
  })
})
