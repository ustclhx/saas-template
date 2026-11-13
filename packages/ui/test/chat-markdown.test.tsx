import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatMarkdown, type ChatMarkdownLabels } from '../src/chat.ts'
import { splitMarkdownBlocks } from '../src/lib/markdown.ts'

// 记录每次 react-markdown 渲染的源文，用于断言已完成的块不重新渲染
const renders = vi.hoisted(() => [] as string[])
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      renders.push(String(props.children))
      return actual.default(props)
    },
  }
})

const labels: ChatMarkdownLabels = {
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败',
  codeBlock: '代码，可横向滚动',
  table: '表格，可横向滚动',
  image: (alt) => `图片：${alt}`,
  footnotes: '脚注',
  footnoteBack: '返回正文',
}

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  renders.length = 0
})

describe('ChatMarkdown 安全渲染', () => {
  it('正文中的原始 HTML 不产生元素', () => {
    const { container } = render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={
          '前文 <script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<iframe src="https://evil.example"></iframe>\n\n行内 <b onclick="x()">粗</b> 结束'
        }
      />,
    )
    expect(container.querySelector('script, img, iframe, b, [onerror], [onclick]')).toBeNull()
    expect(container.textContent).toContain('前文')
    expect(container.textContent).toContain('结束')
  })

  it('javascript: 与 data: 链接显示为纯文字，外链带 rel 并在新窗口打开', () => {
    const { container } = render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={
          '[点我](javascript:alert(1)) [数据](data:text/html;base64,PHNjcmlwdD4=) [外链](https://example.com/a) [站内](/app/x)'
        }
      />,
    )
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.textContent)).toEqual(['外链', '站内'])
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc')
    expect(links[1]?.hasAttribute('target')).toBe(false)
    expect(container.textContent).toContain('点我')
    expect(container.textContent).toContain('数据')
    expect(container.innerHTML).not.toMatch(/javascript:|data:text/)
  })

  it('外部图片不产生 <img>，只显示替代文字', () => {
    const { container } = render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={'趋势见下图：![渠道趋势图](https://evil.example/x.png?q=secret)'}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片：渠道趋势图')
    expect(container.innerHTML).not.toContain('evil.example')
  })

  it('表格与代码块在可聚焦、带名称的容器内横向滚动', () => {
    render(
      <ChatMarkdown
        id="m1"
        labels={labels}
        markdown={'| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint(1)\n```'}
      />,
    )
    const table = screen.getByRole('region', { name: labels.table })
    expect(table.tabIndex).toBe(0)
    expect(table.className).toContain('overflow-x-auto')
    expect(table.querySelector('table')).not.toBeNull()
    const code = screen.getByRole('region', { name: labels.codeBlock })
    expect(code.tabIndex).toBe(0)
    expect(code.className).toContain('overflow-x-auto')
    expect(code.closest('[data-chat-code]')?.textContent).toContain('python')
  })

  it('两条消息各有脚注时 id 不冲突', () => {
    const markdown = '正文[^1]。\n\n[^1]: 注释。'
    const { container } = render(
      <>
        <ChatMarkdown id="m1" labels={labels} markdown={markdown} />
        <ChatMarkdown id="m2" labels={labels} markdown={markdown} />
      </>,
    )
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id)
    expect(ids.length).toBeGreaterThanOrEqual(4)
    expect(new Set(ids).size).toBe(ids.length)
    // 脚注链接与 aria-describedby 指向本条消息自己的元素
    for (const link of container.querySelectorAll('a[href^="#"]')) {
      expect(ids).toContain(link.getAttribute('href')?.slice(1))
    }
    for (const element of container.querySelectorAll('[aria-describedby]')) {
      expect(ids).toContain(element.getAttribute('aria-describedby'))
    }
    expect(screen.getAllByText('脚注').length).toBe(2)
  })
})

describe('代码块复制', () => {
  const markdown = '```ts\nconst a = 1\nconsole.log(a)\n```'

  it('写入剪贴板的文本不含语言名，按钮短暂显示已复制并播报', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    setClipboard(writeText)
    vi.useFakeTimers()
    render(<ChatMarkdown id="m1" labels={labels} markdown={markdown} />)
    expect(screen.getByRole('status').textContent).toBe('')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制' }))
    })
    expect(writeText).toHaveBeenCalledWith('const a = 1\nconsole.log(a)')
    expect(screen.getByRole('button').textContent).toBe('已复制')
    expect(screen.getByRole('status').textContent).toBe('已复制')
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('button').textContent).toBe('复制')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('剪贴板拒绝时显示失败文案，没有未处理的异常', async () => {
    setClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    render(<ChatMarkdown id="m1" labels={labels} markdown={markdown} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制' }))
    })
    expect(screen.getByRole('button').textContent).toBe('复制失败')
    expect(screen.getByRole('status').textContent).toBe('复制失败')
  })

  it('浏览器没有剪贴板接口时同样显示失败文案', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    render(<ChatMarkdown id="m1" labels={labels} markdown={markdown} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '复制' }))
    })
    expect(screen.getByRole('status').textContent).toBe('复制失败')
  })
})

const FIXTURES = {
  未闭合代码块: '先看代码：\n\n```python\ndef cac(spend, n):\n    return spend / n\n```\n\n结束。',
  只有表头的表格: '| 渠道 | 新客 |\n| --- | ---: |\n| 搜索 | 1,240 |\n| 内容 | 860 |\n\n表后文字。',
  未闭合强调与链接:
    '这是 **粗体与 [链接](https://example.com/a?b=1) 混排** 和 _斜体_ 结尾。\n\n第二段 `code`。',
  嵌套列表: '- 一\n  - 一点一\n    1. 甲\n    2. 乙\n- 二\n\n> 引用 **强调**\n\n1. 三\n2. 四',
  脚注: '正文[^a]，还有一处[^b]。\n\n[^a]: 第一条。\n[^b]: 第二条 **粗**。\n\n尾段。',
  标题与分隔线:
    '# 标题\n\n段落一\n段落一续\n\n---\n\n## 小标题\n\n    缩进代码\n\n  ```js\n  const x = 1\n  ```\n',
} as const satisfies Record<string, string>

function html(markdown: string, streaming: boolean) {
  const { container, unmount } = render(
    <ChatMarkdown id="m1" labels={labels} markdown={markdown} streaming={streaming} />,
  )
  const result = container.innerHTML
  unmount()
  return result
}

describe('流式按块增量渲染', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：逐字符流式不报错，结束后与整段渲染相同`, () => {
      const errors = vi.spyOn(console, 'error')
      const { container, rerender } = render(
        <ChatMarkdown id="m1" labels={labels} markdown="" streaming />,
      )
      for (let end = 1; end <= fixture.length; end += 1) {
        rerender(
          <ChatMarkdown id="m1" labels={labels} markdown={fixture.slice(0, end)} streaming />,
        )
      }
      // 流式中最后一步的结构与整段渲染一致（只差块之间的换行文本）
      expect(container.innerHTML.replaceAll('>\n<', '><')).toBe(
        html(fixture, false).replaceAll('>\n<', '><'),
      )
      rerender(<ChatMarkdown id="m1" labels={labels} markdown={fixture} />)
      expect(container.innerHTML).toBe(html(fixture, false))
      expect(errors).not.toHaveBeenCalled()
      errors.mockRestore()
    })
  }

  it('已完成的块在后续输入时不重新渲染', () => {
    const fixture = `${FIXTURES.未闭合代码块}\n\n${FIXTURES.嵌套列表}\n\n${FIXTURES.只有表头的表格}`
    const { rerender } = render(<ChatMarkdown id="m1" labels={labels} markdown="" streaming />)
    for (let end = 1; end <= fixture.length; end += 1) {
      renders.length = 0
      rerender(<ChatMarkdown id="m1" labels={labels} markdown={fixture.slice(0, end)} streaming />)
      // 每一步至多渲染两块：仍在增长的最后一块，以及刚刚完成的那一块
      expect(renders.length).toBeLessThanOrEqual(2)
    }
    expect(splitMarkdownBlocks(fixture)?.length).toBeGreaterThan(5)

    // 只在最后一块追加文字：只有最后一块重新渲染，调用方传入新的 labels 对象也不影响
    const blocks = splitMarkdownBlocks(fixture) ?? []
    renders.length = 0
    rerender(<ChatMarkdown id="m1" labels={{ ...labels }} markdown={`${fixture}更多`} streaming />)
    expect(renders).toEqual([`${blocks.at(-1)}更多`])
  })

  it('有脚注或链接引用定义时回退整段渲染', () => {
    expect(splitMarkdownBlocks(FIXTURES.脚注)).toBeNull()
    expect(splitMarkdownBlocks('见 [文档][d]。\n\n[d]: https://example.com')).toBeNull()
    renders.length = 0
    render(<ChatMarkdown id="m1" labels={labels} markdown={FIXTURES.脚注} streaming />)
    expect(renders).toEqual([FIXTURES.脚注])
  })

  it('切分点在顶层块起始行的行首，拼接后与原文相同', () => {
    for (const fixture of Object.values(FIXTURES)) {
      const blocks = splitMarkdownBlocks(fixture)
      if (blocks) expect(blocks.join('')).toBe(fixture)
    }
    expect(splitMarkdownBlocks('a\n\n  ```js\n  x\n  ```\n')).toEqual([
      'a\n\n',
      '  ```js\n  x\n  ```\n',
    ])
  })
})
