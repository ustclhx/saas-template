import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 系统开启「减少动态效果」。motion 在首次使用时读取并缓存这一媒体查询，所以单独成文件、在导入组件前设置
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

const { ChatMessage, ThinkingIndicator, ThinkingSteps, ThinkingStepsHeader, ToolCall } =
  await import('../src/chat.ts')

Reflect.deleteProperty(Element.prototype, 'animate')
afterEach(() => cleanup())

describe('对话组件 · 减少动态效果', () => {
  it('思考中的三点静止（不是 motion 元素，没有透明度动画）', () => {
    render(
      <>
        <ThinkingIndicator label="正在思考" />
        <ThinkingSteps>
          <ThinkingStepsHeader busy>思考中…</ThinkingStepsHeader>
        </ThinkingSteps>
      </>,
    )
    const dots = document.querySelectorAll('[data-thinking-dots] > span')
    expect(dots).toHaveLength(6)
    for (const dot of dots) expect((dot as HTMLElement).style.opacity).toBe('')
    expect(screen.getByText('正在思考')).toBeTruthy()
  })

  it('重试中与执行中的转圈在 CSS 中静止，流式光标由 globals.css 的媒体查询静止', () => {
    const { container } = render(
      <>
        <ChatMessage from="assistant" status="retrying" statusLabel="重试中" entrance={false}>
          正文
        </ChatMessage>
        <ToolCall
          name="工具"
          state="running"
          labels={{ pending: '准备中', running: '执行中', done: '已完成', error: '出错' }}
        />
      </>,
    )
    const spinners = container.querySelectorAll('.animate-spin')
    expect(spinners).toHaveLength(2)
    for (const spinner of spinners)
      expect(spinner.getAttribute('class')).toContain('motion-reduce:animate-none')
  })
})
