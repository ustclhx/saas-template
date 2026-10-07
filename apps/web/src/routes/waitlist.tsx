import { createFileRoute, notFound } from '@tanstack/react-router'
import { GrowthForm } from '../features/growth/forms.tsx'
import { templateConfig } from '../server/template-config.ts'
export const Route = createFileRoute('/waitlist')({
  beforeLoad: () => {
    if (!templateConfig.features.waitlist) throw notFound()
  },
  component: () => <GrowthForm feature="waitlist" />,
})
