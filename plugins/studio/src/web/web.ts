import { createServerOnlyFn } from '@tanstack/react-start'
import type { WebPluginModule } from '@web/features/plugins/contract.ts'
import { studioWorksList, studioWorksModerate } from './admin-mcp-tools.ts'

export default {
  sitemaps: ['/sitemap-gallery.xml'],
} satisfies WebPluginModule

export const adminMcpTools = createServerOnlyFn(() => ({
  'studio.works.list': studioWorksList,
  'studio.works.moderate': studioWorksModerate,
}))
