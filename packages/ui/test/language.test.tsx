import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageMenu } from '../src/components/language-menu.tsx'
import { LanguagePrompt } from '../src/components/language-prompt.tsx'

// 语言提示条与语言切换菜单（openspec multilingual-seo 4.2、4.3）：普通链接、hreflang、关闭回调与当前项标记。

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(() => cleanup())

const labels = {
  region: '语言建议',
  message: '本页有中文版本',
  action: '查看中文版',
  close: '关闭语言提示',
}

describe('LanguagePrompt', () => {
  it('用建议语言输出区域、普通链接与关闭按钮，带 data-language-prompt 标记', () => {
    render(<LanguagePrompt href="/zh/pricing" hrefLang="zh" labels={labels} onDismiss={() => {}} />)
    const region = screen.getByRole('complementary', { name: '语言建议' })
    expect(region.getAttribute('lang')).toBe('zh')
    expect(region.getAttribute('dir')).toBe('ltr')
    expect(region.hasAttribute('data-language-prompt')).toBe(true)
    expect(region.className).toContain('fixed')
    expect(region.className).toContain('animate-float-enter')
    expect(region.className).toContain('motion-reduce:animate-float-fade-in')
    const link = screen.getByRole('link', { name: '查看中文版' })
    expect(link.getAttribute('href')).toBe('/zh/pricing')
    expect(link.getAttribute('hreflang')).toBe('zh')
    expect(screen.getByText('本页有中文版本')).toBeTruthy()
  })

  it('RTL 语言整体镜像', () => {
    render(
      <LanguagePrompt href="/ar" hrefLang="ar" dir="rtl" labels={labels} onDismiss={() => {}} />,
    )
    expect(screen.getByRole('complementary').getAttribute('dir')).toBe('rtl')
  })

  it('关闭：播放退出动画后回调一次；动画事件缺失时由兜底计时器回调', async () => {
    const onDismiss = vi.fn()
    render(<LanguagePrompt href="/zh" hrefLang="zh" labels={labels} onDismiss={onDismiss} />)
    const region = screen.getByRole('complementary')
    fireEvent.click(screen.getByRole('button', { name: '关闭语言提示' }))
    expect(region.className).toContain('animate-float-exit')
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.animationEnd(region)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    cleanup()

    const late = vi.fn()
    render(<LanguagePrompt href="/zh" hrefLang="zh" labels={labels} onDismiss={late} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭语言提示' }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('点击链接回调 onFollow，不阻止跳转', () => {
    const onFollow = vi.fn()
    render(
      <LanguagePrompt
        href="/zh"
        hrefLang="zh"
        labels={labels}
        onDismiss={() => {}}
        onFollow={onFollow}
      />,
    )
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByRole('link').dispatchEvent(event)
    expect(onFollow).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('LanguageMenu', () => {
  const items = [
    { locale: 'en', label: 'English', href: '/blog/a', current: true },
    { locale: 'zh', label: '中文', href: '/zh/blog/a' },
  ]

  it('服务端输出即显示当前语言，菜单项不进入服务端 HTML', () => {
    const html = renderToString(<LanguageMenu label="Language" items={items} disabled />)
    expect(html).toContain('English')
    expect(html).toContain('aria-label="Language"')
    expect(html).not.toContain('/zh/blog/a')
  })

  it('展开后每项是带 hreflang 的普通链接，当前项 aria-current="page"', async () => {
    const onItemClick = vi.fn()
    render(<LanguageMenu label="Language" items={items} onItemClick={onItemClick} />)
    const trigger = screen.getByRole('button', { name: 'Language' })
    act(() => trigger.focus())
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await screen.findByRole('menu')
    const links = screen.getAllByRole('menuitem')
    expect(links.map((link) => link.tagName)).toEqual(['A', 'A'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/blog/a', '/zh/blog/a'])
    expect(links.map((link) => link.getAttribute('hreflang'))).toEqual(['en', 'zh'])
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual(['page', null])
    fireEvent.click(links[1] as HTMLElement)
    expect(onItemClick).toHaveBeenCalledWith(items[1], expect.anything())
  })
})
