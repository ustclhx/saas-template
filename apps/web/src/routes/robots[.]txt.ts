import { createFileRoute } from '@tanstack/react-router'
import { robots } from '../features/seo/crawlers.ts'
import webPlugins from '../plugins.gen.ts'
import { getWebRuntime } from '../server/runtime.ts'

const pluginSitemaps = webPlugins.flatMap(({ entry }) => entry.sitemaps ?? [])

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(robots(getWebRuntime().config.APP_URL, pluginSitemaps), {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=300',
          },
        }),
    },
  },
})
