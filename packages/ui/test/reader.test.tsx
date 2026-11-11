import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Reader,
  ReaderEmpty,
  ReaderError,
  type ReaderLabels,
  registerPdfExporter,
} from '../src/index.ts'
import { extractHeadings, safeMarkdownUrl } from '../src/lib/markdown.ts'

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

const labels: ReaderLabels = {
  toc: 'Contents',
  progress: 'Reading progress',
  exportPdf: 'Export PDF',
  printPdf: 'Print',
  serverPdf: 'Download PDF',
  loading: 'Loading',
}

const DOC = `## Summary

Intro text with a [site link](/docs/a) and an [external link](https://example.com/x).

## Key metrics

### New users

| Metric | Q2 |
| --- | ---: |
| Signups | 10 |

### Retention

Text.

## Costs

More text.
`

let unregister: (() => void) | null = null

// happy-dom 没有布局：按元素给出模拟位置（顶栏高 56，正文从 100 开始、高 4000，各节标题间隔 600）
let scrollY = 0

function mockLayout() {
  scrollY = 0
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('data-slot') === 'reader-bar') return rect(0, 56)
    if (this.getAttribute('data-slot') === 'reader-article') return rect(100 - scrollY, 4000)
    const headings = [...(this.ownerDocument.querySelectorAll('article [id^="section-"]') ?? [])]
    const index = headings.indexOf(this)
    return index >= 0 ? rect(300 + index * 600 - scrollY, 28) : rect(0, 0)
  })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  window.print = () => {}
  mockLayout()
})

afterEach(() => {
  unregister?.()
  unregister = null
  cleanup()
  vi.restoreAllMocks()
})

describe('safeMarkdownUrl', () => {
  it('只放行 http、https 与站内地址', () => {
    expect(safeMarkdownUrl('https://example.com')).toBe('https://example.com')
    expect(safeMarkdownUrl('HTTP://example.com')).toBe('HTTP://example.com')
    expect(safeMarkdownUrl('/app/x')).toBe('/app/x')
    expect(safeMarkdownUrl('#part')).toBe('#part')
    expect(safeMarkdownUrl('relative/path')).toBe('relative/path')
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' \u0001javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox',
      'mailto:a@example.com',
      'file:///etc/passwd',
    ]) {
      expect(safeMarkdownUrl(bad), bad).toBe('')
    }
  })
})

describe('extractHeadings', () => {
  it('收集二、三级标题并为重名标题加后缀', () => {
    const headings = extractHeadings('# Title\n\n## A\n\n### B\n\n#### C\n\n## A\n\n## 摘要')
    expect(headings).toEqual([
      { id: 'section-a', text: 'A', level: 2 },
      { id: 'section-b', text: 'B', level: 3 },
      { id: 'section-a-2', text: 'A', level: 2 },
      { id: 'section-摘要', text: '摘要', level: 2 },
    ])
  })
})

describe('Reader 安全渲染', () => {
  it('原始 HTML、脚本与事件属性不渲染，危险协议链接不可点击', () => {
    const alertSpy = vi.fn()
    ;(window as unknown as { pwned: () => void }).pwned = alertSpy
    const markdown = [
      '## Unsafe',
      '<script>window.pwned()</script>',
      '<img src="x" onerror="window.pwned()">',
      '<a href="https://example.com" onclick="window.pwned()">inline html</a>',
      '<iframe src="https://example.com"></iframe>',
      '[js link](javascript:window.pwned())',
      '[entity link](&#106;avascript:window.pwned())',
      '[data link](data:text/html;base64,PHNjcmlwdD4=)',
      '![data image](data:image/svg+xml;base64,PHN2Zz4=)',
      '<details open ontoggle="window.pwned()">x</details>',
    ].join('\n\n')
    const { container } = render(<Reader title="Doc" markdown={markdown} labels={labels} />)
    const article = container.querySelector('article') as HTMLElement
    expect(article.querySelector('script, iframe, details, [onerror], [onclick]')).toBeNull()
    for (const el of article.querySelectorAll('*')) {
      for (const attr of el.attributes) expect(attr.name.startsWith('on'), attr.name).toBe(false)
    }
    const hrefs = [...article.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs.filter((href) => !href || /^\s*(javascript|data):/i.test(href))).toEqual([])
    expect(within(article).getByText('js link').tagName).toBe('SPAN')
    expect(within(article).getByText('entity link').tagName).toBe('SPAN')
    expect(within(article).getByText('data link').tagName).toBe('SPAN')
    expect(article.querySelector('img')).toBeNull()
    expect(article.textContent).not.toContain('window.pwned')
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('外链新窗口打开并带 noopener noreferrer，站内链接不带', () => {
    render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const external = screen.getByRole('link', { name: 'external link' })
    expect(external.getAttribute('target')).toBe('_blank')
    expect(external.getAttribute('rel')).toBe('noopener noreferrer')
    const internal = screen.getByRole('link', { name: 'site link' })
    expect(internal.getAttribute('href')).toBe('/docs/a')
    expect(internal.hasAttribute('target')).toBe(false)
    expect(internal.hasAttribute('rel')).toBe(false)
  })
})

describe('Reader 目录', () => {
  it('由 h2 / h3 生成目录，标题带对应 id', () => {
    const { container } = render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const toc = container.querySelector('[data-slot="reader-toc"]') as HTMLElement
    const links = within(toc).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Summary',
      'Key metrics',
      'New users',
      'Retention',
      'Costs',
    ])
    for (const link of links) {
      const id = decodeURIComponent((link.getAttribute('href') ?? '').slice(1))
      expect(container.querySelector(`[id="${id}"]`)?.textContent).toBe(link.textContent)
    }
    // 初始高亮第一节
    expect(links[0]?.getAttribute('aria-current')).toBe('location')
  })

  it('滚动时高亮越过顶栏的最后一节，进度随之更新', async () => {
    const { container } = render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const toc = container.querySelector('[data-slot="reader-toc"]') as HTMLElement
    const progress = () => Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))
    expect(progress()).toBe(0)
    // 第三个标题（New users）位于 300 + 2 * 600 = 1500，滚动 1450 后越过 56 + 32 的判定线
    scrollY = 1450
    await act(async () => {
      window.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(within(toc).getByRole('link', { name: 'New users' }).getAttribute('aria-current')).toBe(
      'location',
    )
    expect(progress()).toBeGreaterThan(30)
    expect(progress()).toBeLessThan(60)
  })

  it('点击目录滚动到对应标题并高亮该项', () => {
    const scrolled: string[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this.id)
    })
    const { container } = render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const toc = container.querySelector('[data-slot="reader-toc"]') as HTMLElement
    fireEvent.click(within(toc).getByRole('link', { name: 'Retention' }))
    expect(scrolled).toEqual(['section-retention'])
    expect(within(toc).getByRole('link', { name: 'Retention' }).getAttribute('aria-current')).toBe(
      'location',
    )
    expect(within(toc).getByRole('link', { name: 'Summary' }).hasAttribute('aria-current')).toBe(
      false,
    )
    expect(document.activeElement?.id).toBe('section-retention')
    expect(window.location.hash).toBe(`#${encodeURIComponent('section-retention')}`)
  })

  it('移动端目录下拉：展开、选择后收起并跳转，Esc 收起并把焦点还给按钮', () => {
    const scrolled: string[] = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this.id)
    })
    const { container } = render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const bar = container.querySelector('[data-slot="reader-mobile-toc"]') as HTMLElement
    const toggle = within(bar).getByRole('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Summary')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(bar).getByRole('link', { name: 'Costs' }))
    expect(scrolled).toEqual(['section-costs'])
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('Costs')

    fireEvent.click(toggle)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })
})

describe('Reader 导出与打印', () => {
  it('未注册服务端导出时只有浏览器打印', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const button = screen.getByRole('button', { name: 'Export PDF' })
    expect(button.getAttribute('aria-haspopup')).toBeNull()
    fireEvent.click(button)
    expect(print).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Download PDF')).toBeNull()
  })

  it('注册后导出按钮变为菜单，可选浏览器打印或服务端导出', async () => {
    const exporter = vi.fn()
    unregister = registerPdfExporter(exporter)
    render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    const button = screen.getByRole('button', { name: 'Export PDF' })
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    // Radix 菜单由 pointerdown 打开
    fireEvent.pointerDown(button, { button: 0, pointerType: 'mouse' })
    const item = await screen.findByRole('menuitem', { name: 'Download PDF' })
    expect(screen.getByRole('menuitem', { name: 'Print' })).toBeTruthy()
    await act(async () => {
      fireEvent.click(item)
    })
    expect(exporter).toHaveBeenCalledWith({ title: 'Doc', markdown: DOC })

    // 注销后回到只有浏览器打印
    act(() => {
      unregister?.()
    })
    unregister = null
    expect(
      screen.getByRole('button', { name: 'Export PDF' }).getAttribute('aria-haspopup'),
    ).toBeNull()
  })

  it('服务端渲染时视为未注册；顶栏、目录与尾部插槽带打印隐藏类，二级标题打印分页', () => {
    unregister = registerPdfExporter(() => {})
    const html = renderToString(
      <Reader title="Doc" markdown={DOC} labels={labels} footer={<p>Footer slot</p>} />,
    )
    expect(html).not.toContain('aria-haspopup')
    const host = document.createElement('div')
    host.innerHTML = html
    for (const slot of ['reader-bar', 'reader-toc', 'reader-footer']) {
      expect(host.querySelector(`[data-slot="${slot}"]`)?.className, slot).toContain('print:hidden')
    }
    const h2 = host.querySelector('article h2') as HTMLElement
    expect(h2.className).toContain('print:[&:not(:first-of-type)]:break-before-page')
  })
})

describe('Reader 状态', () => {
  it('加载、空、错误状态各自显示，进度为 0，导出不可用', () => {
    const { rerender, container } = render(<Reader title="Doc" status="loading" labels={labels} />)
    expect(screen.getByRole('status').textContent).toBe('Loading')
    expect(container.querySelector('article')).toBeNull()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
    expect((screen.getByRole('button', { name: 'Export PDF' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    rerender(
      <Reader
        title="Doc"
        status="empty"
        labels={labels}
        emptyState={<ReaderEmpty title="Nothing yet" description="Generate it first." />}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Nothing yet' })).toBeTruthy()

    const onRetry = vi.fn()
    rerender(
      <Reader
        title="Doc"
        status="error"
        labels={labels}
        errorState={
          <ReaderError
            title="Failed"
            description="Try again."
            retryLabel="Retry"
            onRetry={onRetry}
          />
        }
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('打印前临时去掉深色主题，打印后还原', () => {
    document.documentElement.classList.add('dark')
    render(<Reader title="Doc" markdown={DOC} labels={labels} />)
    window.dispatchEvent(new Event('beforeprint'))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    window.dispatchEvent(new Event('afterprint'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    document.documentElement.classList.remove('dark')
  })
})
