import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageFeedback, SuggestionChips } from './chat-extras.tsx'

// add-subject-chat tasks.md 6.1：推荐按钮与评分组件的最小实现（视觉由 8.6 替换，props 保持不变）。

describe('SuggestionChips', () => {
  it('renders one button per suggestion and nothing when empty', () => {
    const html = renderToStaticMarkup(
      <SuggestionChips suggestions={['Summarize it', 'What next?']} onSelect={() => {}} />,
    )
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('Summarize it')
    expect(renderToStaticMarkup(<SuggestionChips suggestions={[]} onSelect={() => {}} />)).toBe('')
  })
})

describe('MessageFeedback', () => {
  it('marks the current rating as pressed and offers undo', () => {
    const html = renderToStaticMarkup(
      <MessageFeedback
        messageId="m"
        value={{ rating: 'down', comment: null }}
        onChange={async () => {}}
      />,
    )
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^<]*(Not helpful|没帮助)/)
    expect(html).toMatch(/Remove rating|撤销评价/)
    const empty = renderToStaticMarkup(
      <MessageFeedback messageId="m" value={null} onChange={async () => {}} />,
    )
    expect(empty).not.toMatch(/Remove rating|撤销评价/)
  })
})
