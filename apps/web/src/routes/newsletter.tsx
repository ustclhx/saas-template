import { createFileRoute, notFound } from '@tanstack/react-router'
import { GrowthForm } from '../features/growth/forms.tsx'
import { StaticPageBreadcrumb, staticTrail } from '../features/marketing/page-links.tsx'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { mainLabel } from '../features/seo/page-links.ts'
import { breadcrumbData } from '../features/seo/structured-data.ts'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'
export const Route = createFileRoute('/newsletter')({
  beforeLoad: () => {
    if (!templateConfig.features.newsletter) throw notFound()
  },
  head: ({ matches }) => {
    const page = staticPage('/newsletter', getLocale())
    const appUrl = originFromMatches(matches)
    return pageHead(page, appUrl, [
      breadcrumbData(staticTrail(page.path, page.locale), mainLabel(page), appUrl, page.locale),
    ])
  },
  component: () => (
    <>
      <StaticPageBreadcrumb path="/newsletter" className="mx-auto max-w-lg px-6 pt-8" />
      <GrowthForm feature="newsletter" />
    </>
  ),
})
