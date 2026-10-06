import { createFileRoute } from '@tanstack/react-router'
import { m } from '../paraglide/messages.js'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <main>
      <h1>SaaS Template</h1>
      <p data-testid="tagline">{m.common_site_tagline()}</p>
      <p data-testid="version">v{__APP_VERSION__}</p>
    </main>
  )
}
