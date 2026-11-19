import {
  Breadcrumb,
  LinkCardGrid,
  LinkList,
  Pagination,
  type PaginationLabels,
  SeriesNav,
} from '@saas/ui'
import { m } from '../../paraglide/messages.js'
import { PreviewSection, Specimen } from './layout.tsx'

// 公开页内链组件（openspec seo-internal-linking 组 3）：示例数据为中性的「AI 写作入门」课程系列，
// 与设计稿副本 docs/design-system/prototypes/seo-internal-linking/ 的文案一致。链接指向本页锚点，点击不离开预览页。

const href = (slug: string) => `#linking-${slug}`

const TITLES = [
  m.ui_preview_link_t1,
  m.ui_preview_link_t2,
  m.ui_preview_link_t3,
  m.ui_preview_link_t4,
  m.ui_preview_link_t5,
  m.ui_preview_link_t6,
  m.ui_preview_link_t7,
  m.ui_preview_link_t8,
] as const

function lesson(n: number) {
  const title = TITLES[n - 1]?.() ?? ''
  return { href: href(`lesson-${n}`), title: m.ui_preview_link_lesson({ n, title }) }
}

function paginationLabels(): PaginationLabels {
  return {
    nav: m.ui_preview_link_pagination(),
    previous: m.ui_preview_link_previous_page(),
    next: m.ui_preview_link_next_page(),
    page: (page) => m.ui_preview_link_page({ page }),
  }
}

const pageHref = (page: number) => href(page === 1 ? 'blog' : `blog-page-${page}`)

// 内链区块放在页面底色上（与设计稿一致），而不是预览格默认的卡片表面
const onPage = 'block bg-background'

export function LinkingSection() {
  const crumbs = [
    { label: m.ui_preview_link_home(), href: href('home') },
    { label: m.ui_preview_link_blog(), href: href('blog') },
    { label: m.ui_preview_link_course(), href: href('course') },
  ]
  const labels = paginationLabels()
  return (
    <PreviewSection
      id="linking"
      title="Breadcrumb · Pagination · LinkCard · LinkList"
      description={m.ui_preview_link_desc()}
    >
      <Specimen label={m.ui_preview_link_s_breadcrumb()} wide className={onPage}>
        <Breadcrumb
          label={m.ui_preview_link_breadcrumb()}
          items={crumbs}
          current={lesson(5).title}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_breadcrumb_hub()} className={onPage}>
        <Breadcrumb
          label={m.ui_preview_link_breadcrumb()}
          items={crumbs.slice(0, 1)}
          current={m.ui_preview_link_blog()}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_breadcrumb_long()} className={onPage}>
        <Breadcrumb
          label={m.ui_preview_link_breadcrumb()}
          items={[
            { label: m.ui_preview_link_home(), href: href('home') },
            { label: m.ui_preview_link_guides(), href: href('guides') },
          ]}
          current={m.ui_preview_link_long()}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_pagination()} wide className={onPage}>
        <Pagination page={5} pageCount={12} hrefFor={pageHref} labels={labels} />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_pagination_first()} className={onPage}>
        <Pagination page={1} pageCount={3} hrefFor={pageHref} labels={labels} />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_pagination_last()} className={onPage}>
        <Pagination page={2} pageCount={2} hrefFor={pageHref} labels={labels} />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_series()} wide className={onPage}>
        <SeriesNav
          label={m.ui_preview_link_series()}
          previous={{ ...lesson(4), label: m.ui_preview_link_previous() }}
          next={{ ...lesson(6), label: m.ui_preview_link_next() }}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_series_next()} wide className={onPage}>
        <SeriesNav
          label={m.ui_preview_link_series()}
          next={{ ...lesson(2), label: m.ui_preview_link_next() }}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_series_prev()} wide className={onPage}>
        <SeriesNav
          label={m.ui_preview_link_series()}
          previous={{
            href: href('long'),
            title: m.ui_preview_link_long(),
            label: m.ui_preview_link_previous(),
          }}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_related()} wide className={onPage}>
        <LinkCardGrid
          title={m.ui_preview_link_related()}
          items={[
            {
              href: href('formats'),
              title: m.ui_preview_link_r1(),
              description: m.ui_preview_link_r1_desc(),
            },
            {
              href: href('checklist'),
              title: m.ui_preview_link_r2(),
              description: m.ui_preview_link_r2_desc(),
            },
            {
              href: href('summary'),
              title: m.ui_preview_link_r3(),
              description: m.ui_preview_link_r3_desc(),
            },
          ]}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_hub()} wide className={onPage}>
        <LinkCardGrid
          columns={2}
          zone={null}
          items={[1, 2, 3, 4].map((n) => ({
            ...lesson(n),
            eyebrow: `2026-11-0${n}`,
            description: m.ui_preview_link_r1_desc(),
          }))}
        />
      </Specimen>
      <Specimen label={m.ui_preview_link_s_siblings()} wide className={onPage}>
        <LinkList
          title={m.ui_preview_link_siblings()}
          group="ai-writing"
          items={[1, 2, 3, 7, 8].map((n) => {
            const { href: to, title } = lesson(n)
            return { href: to, label: title }
          })}
          viewAll={{ href: href('course'), label: m.ui_preview_link_view_all() }}
        />
      </Specimen>
    </PreviewSection>
  )
}
