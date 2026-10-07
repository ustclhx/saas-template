import { createFileRoute, notFound } from '@tanstack/react-router'
import { GrowthForm } from '../features/growth/forms.tsx'
import { templateConfig } from '../server/template-config.ts'
export const Route = createFileRoute('/newsletter')({
  beforeLoad: () => {
    if (!templateConfig.features.newsletter) throw notFound()
  },
  component: () => <GrowthForm feature="newsletter" />,
})
