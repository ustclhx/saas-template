import { mediaTaskHoldSweeper } from '@saas/ai'
import type { TemplateConfig } from '@saas/config'

export const holdSweepers = [
  {
    refType: 'ai_task',
    create(template: TemplateConfig) {
      if (template.plugins.media && (template.ai.image || template.ai.video))
        return mediaTaskHoldSweeper()
    },
  },
] as const
