import { createFileRoute, notFound } from '@tanstack/react-router'
import { ReaderPreviewPage } from '../../features/ui-preview/reader-page.tsx'
import { READER_STATUSES } from '../../features/ui-preview/section-reader.tsx'
import { getUiPreviewEnabled } from '../../features/ui-preview/ui-preview.functions.ts'
import { m } from '../../paraglide/messages.js'

type ReaderPreviewState = (typeof READER_STATUSES)[number]

// 长文阅读器整页预览（tasks 8.4）：与 /dev/ui 同一开关，只在 UI_PREVIEW=true 时开放，noindex
export const Route = createFileRoute('/dev/ui_/reader')({
  validateSearch: (search: Record<string, unknown>): { state?: ReaderPreviewState } =>
    READER_STATUSES.includes(search.state as ReaderPreviewState)
      ? { state: search.state as ReaderPreviewState }
      : {},
  beforeLoad: async () => {
    if (!(await getUiPreviewEnabled())) throw notFound()
  },
  head: () => ({
    meta: [
      { title: m.ui_preview_reader_title() },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: ReaderPreviewRoute,
})

function ReaderPreviewRoute() {
  const { state } = Route.useSearch()
  return <ReaderPreviewPage status={state ?? 'ready'} />
}
