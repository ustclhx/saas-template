import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <main>
      <h1>SaaS Template</h1>
      <p data-testid="version">v{__APP_VERSION__}</p>
    </main>
  )
}
