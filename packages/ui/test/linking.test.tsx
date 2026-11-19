import { cleanup, render, screen, within } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Breadcrumb } from '../src/components/breadcrumb.tsx'
import { LinkCard, LinkCardGrid, SeriesNav } from '../src/components/link-card.tsx'
import { LinkList } from '../src/components/link-list.tsx'
import type { RenderLink } from '../src/components/link-render.tsx'
import { Pagination, paginationRange } from '../src/components/pagination.tsx'

// 公开页内链组件（openspec seo-internal-linking 3.5）：真实 <a href>、当前项 aria-current、
// 缺省时不渲染、区域标记与分页页码窗口。

afterEach(cleanup)

const labels = {
  nav: '分页',
  previous: '上一页',
  next: '下一页',
  page: (n: number) => `第 ${n} 页`,
}

describe('Breadcrumb', () => {
  const items = [
    { label: '首页', href: '/' },
    { label: '博客', href: '/blog' },
  ]

  it('上级是真实 <a href>，当前项不是链接并带 aria-current，外层为 nav 区域', () => {
    render(<Breadcrumb label="面包屑" items={items} current="第 5 课" />)
    const nav = screen.getByRole('navigation', { name: '面包屑' })
    expect(nav.dataset.linkZone).toBe('nav')
    const links = within(nav).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/', '/blog'])
    expect(links.map((a) => a.textContent)).toEqual(['首页', '博客'])
    const current = nav.querySelector('[aria-current="page"]')
    expect(current?.textContent).toBe('第 5 课')
    expect(current?.querySelector('a')).toBeNull()
    expect(current?.tagName).toBe('LI')
  })

  it('zone 可覆盖或去掉；renderLink 替换链接元素', () => {
    const renderLink: RenderLink = (props) => <a data-router="" {...props} />
    const { container, rerender } = render(
      <Breadcrumb label="面包屑" items={items} current="x" zone="crumbs" renderLink={renderLink} />,
    )
    const nav = container.querySelector('nav') as HTMLElement
    expect(nav.dataset.linkZone).toBe('crumbs')
    expect(nav.querySelectorAll('a[data-router][href]')).toHaveLength(2)
    rerender(<Breadcrumb label="面包屑" items={items} current="x" zone={null} />)
    expect(container.querySelector('nav')?.hasAttribute('data-link-zone')).toBe(false)
  })
})

describe('paginationRange', () => {
  it('首页、末页、当前页前后各一页，中间省略号', () => {
    expect(paginationRange(5, 12)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 12])
    expect(paginationRange(1, 12)).toEqual([1, 2, 'ellipsis', 12])
    expect(paginationRange(12, 12)).toEqual([1, 'ellipsis', 11, 12])
  })

  it('只隔一页时显示那一页而不是省略号', () => {
    expect(paginationRange(3, 12)).toEqual([1, 2, 3, 4, 'ellipsis', 12])
    expect(paginationRange(4, 12)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 12])
    expect(paginationRange(9, 12)).toEqual([1, 'ellipsis', 8, 9, 10, 11, 12])
  })

  it('页数少时全部列出；越界按边界处理', () => {
    expect(paginationRange(1, 1)).toEqual([1])
    expect(paginationRange(2, 2)).toEqual([1, 2])
    expect(paginationRange(2, 5)).toEqual([1, 2, 3, 4, 5])
    expect(paginationRange(99, 3)).toEqual([1, 2, 3])
    expect(paginationRange(0, 3)).toEqual([1, 2, 3])
    expect(paginationRange(1, 0)).toEqual([])
  })
})

describe('Pagination', () => {
  const hrefFor = (n: number) => (n === 1 ? '/blog' : `/blog/page/${n}`)

  it('页码与上一页 / 下一页是真实链接，当前页不是链接并带 aria-current', () => {
    render(<Pagination page={5} pageCount={12} hrefFor={hrefFor} labels={labels} />)
    const nav = screen.getByRole('navigation', { name: '分页' })
    expect(screen.getByRole('link', { name: '上一页' }).getAttribute('href')).toBe('/blog/page/4')
    expect(screen.getByRole('link', { name: '下一页' }).getAttribute('href')).toBe('/blog/page/6')
    expect(screen.getByRole('link', { name: '第 1 页' }).getAttribute('href')).toBe('/blog')
    expect(screen.getByRole('link', { name: '第 12 页' }).getAttribute('href')).toBe(
      '/blog/page/12',
    )
    expect(screen.queryByRole('link', { name: '第 5 页' })).toBeNull()
    const current = nav.querySelector('[aria-current="page"]')
    expect(current?.tagName).toBe('SPAN')
    expect(current?.textContent).toContain('5')
    expect(nav.hasAttribute('data-link-zone')).toBe(false)
  })

  it('第一页没有上一页链接、最后一页没有下一页链接', () => {
    const { rerender } = render(
      <Pagination page={1} pageCount={3} hrefFor={hrefFor} labels={labels} />,
    )
    expect(screen.queryByRole('link', { name: '上一页' })).toBeNull()
    expect(screen.getByText('上一页').closest('a')).toBeNull()
    expect(screen.getByRole('link', { name: '下一页' })).toBeTruthy()
    rerender(<Pagination page={3} pageCount={3} hrefFor={hrefFor} labels={labels} />)
    expect(screen.queryByRole('link', { name: '下一页' })).toBeNull()
    expect(screen.getByRole('link', { name: '上一页' }).getAttribute('href')).toBe('/blog/page/2')
  })

  it('只有一页时不渲染', () => {
    const { container } = render(
      <Pagination page={1} pageCount={1} hrefFor={hrefFor} labels={labels} />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('LinkCard · SeriesNav · LinkCardGrid', () => {
  it('整张卡片是一个 <a href>，锚文本为标题', () => {
    render(<LinkCard href="/blog/a" title="输出格式模板" description="五种常用结构" />)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('/blog/a')
    expect(link.textContent).toBe('输出格式模板五种常用结构')
  })

  it('系列导航：两侧都有时各一个链接，外层为 series 区域', () => {
    render(
      <SeriesNav
        label="系列导航"
        previous={{ href: '/4', title: '第 4 课', label: '上一篇' }}
        next={{ href: '/6', title: '第 6 课', label: '下一篇' }}
      />,
    )
    const nav = screen.getByRole('navigation', { name: '系列导航' })
    expect(nav.dataset.linkZone).toBe('series')
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/4', '/6'])
  })

  it('没有上一篇时只渲染下一篇，并保留占位；两侧都没有时不渲染', () => {
    const { container, rerender } = render(
      <SeriesNav label="系列导航" next={{ href: '/2', title: '第 2 课', label: '下一篇' }} />,
    )
    const nav = screen.getByRole('navigation', { name: '系列导航' })
    expect(within(nav).getAllByRole('link')).toHaveLength(1)
    expect(within(nav).queryByText('上一篇')).toBeNull()
    expect(nav.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    rerender(<SeriesNav label="系列导航" previous={null} next={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('相关区块：related 区域、h2 标题、每项一个链接；为空时不渲染', () => {
    const { container, rerender } = render(
      <LinkCardGrid
        title="相关文章"
        items={[
          { href: '/a', title: 'A', description: '说明' },
          { href: '/b', title: 'B' },
        ]}
      />,
    )
    const section = screen.getByRole('region', { name: '相关文章' })
    expect(section.dataset.linkZone).toBe('related')
    expect(within(section).getAllByRole('link')).toHaveLength(2)
    rerender(<LinkCardGrid title="相关文章" items={[]} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('LinkList', () => {
  const items = [
    { href: '/1', label: '第 1 课' },
    { href: '/2', label: '第 2 课' },
  ]

  it('siblings 区域，列表与「查看全部」都是真实链接', () => {
    render(
      <LinkList
        title="本系列其他课程"
        items={items}
        viewAll={{ href: '/s', label: '全部 9 课' }}
      />,
    )
    const section = screen.getByRole('region', { name: '本系列其他课程' })
    expect(section.dataset.linkZone).toBe('siblings')
    expect(section.hasAttribute('data-link-group')).toBe(false)
    expect(within(section).getAllByRole('listitem')).toHaveLength(2)
    expect(
      within(section)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/1', '/2', '/s'])
  })

  it('没有「查看全部」时只渲染列表；items 为空时不渲染', () => {
    const { container, rerender } = render(<LinkList title="同组" items={items} />)
    expect(screen.getAllByRole('link')).toHaveLength(2)
    rerender(<LinkList title="同组" items={[]} viewAll={{ href: '/s', label: '全部' }} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('LinkList group', () => {
  it('传入 group 时外层输出 data-link-group，并保留 siblings 区域', () => {
    render(<LinkList title="同组" group="ai-writing" items={[{ href: '/1', label: '第 1 课' }]} />)
    const section = screen.getByRole('region', { name: '同组' })
    expect(section.dataset.linkGroup).toBe('ai-writing')
    expect(section.dataset.linkZone).toBe('siblings')
  })
})

describe('服务端渲染', () => {
  it('不依赖水合即输出带 href 的 <a>（链接图只计入 <a href>）', () => {
    const html = renderToStaticMarkup(
      <>
        <Breadcrumb label="面包屑" items={[{ label: '首页', href: '/' }]} current="博客" />
        <Pagination page={2} pageCount={3} hrefFor={(n) => `/p/${n}`} labels={labels} />
        <SeriesNav label="系列" next={{ href: '/n', title: 'N', label: '下一篇' }} />
        <LinkList title="同组" items={[{ href: '/s1', label: 'S1' }]} />
      </>,
    )
    for (const href of ['/', '/p/1', '/p/3', '/n', '/s1']) expect(html).toContain(`href="${href}"`)
    expect(html).toContain('data-link-zone="nav"')
    expect(html).toContain('data-link-zone="series"')
    expect(html).toContain('data-link-zone="siblings"')
  })
})
