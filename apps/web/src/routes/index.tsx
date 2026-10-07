import { createFileRoute } from '@tanstack/react-router'
import { MarketingShell } from '../features/marketing/marketing-shell.tsx'
import { placeholderPlans } from '../features/marketing/pricing-placeholder.ts'
import { Cta } from '../features/marketing/sections/cta.tsx'
import { Faq } from '../features/marketing/sections/faq.tsx'
import { Features } from '../features/marketing/sections/features.tsx'
import { Hero } from '../features/marketing/sections/hero.tsx'
import { Pricing } from '../features/marketing/sections/pricing.tsx'
import { Testimonials } from '../features/marketing/sections/testimonials.tsx'

// 首页（tasks.md 3.1）：各区块均为静态文案与数据，构建期预渲染，不依赖数据库（features/marketing/prerender.ts）
export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <MarketingShell>
      <Hero />
      <Features />
      <Pricing plans={placeholderPlans} />
      <Testimonials />
      <Faq />
      <Cta />
      <p data-testid="version" className="sr-only">
        v{__APP_VERSION__}
      </p>
    </MarketingShell>
  )
}
