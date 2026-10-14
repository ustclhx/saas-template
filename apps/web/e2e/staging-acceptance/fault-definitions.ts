import type { AcceptanceFaultMode, Pricing } from '@saas/ai'
import { deepseekCall, deepseekToken, falImage, workersImage } from './models.ts'

export interface FaultModelDefinition {
  key: string
  kind: 'text' | 'image'
  provider: string
  providerModelId: string
  pricing: Pricing
  sort: number
  params: Record<string, unknown>
  paramsSchema: Record<string, unknown>
  mode: AcceptanceFaultMode
}

const mediaModes = [
  'workers-error',
  'workers-timeout',
  'fal-callback-lost',
  'fal-callback-early',
  'fal-submit-response-lost',
  'fal-provider-error',
  'fal-timeout',
] as const

export const FAULT_MODELS: readonly FaultModelDefinition[] = [
  ...mediaModes.map((mode, index) => {
    const base = mode.startsWith('workers-') ? workersImage : falImage
    return {
      ...base,
      key: `acceptance-fault-${mode}`,
      mode,
      sort: -2000 + index,
      params: { ...base.params },
      paramsSchema: { ...base.paramsSchema, 'x-acceptance-fault': { mode } },
    }
  }),
  ...(['chat-before-stream', 'chat-mid-stream'] as const).flatMap((mode, index) =>
    [deepseekToken, deepseekCall].map((base, pricingIndex) => ({
      ...base,
      key: `acceptance-fault-${mode}-${base.pricing.mode}`,
      mode,
      sort: -1990 + index * 2 + pricingIndex,
      params: {},
      paramsSchema: {
        'x-text': { tokensPerChar: 1, maxOutputTokens: 1024 },
        'x-acceptance-fault': { mode },
      },
    })),
  ),
]

export function faultScenarioId(model: FaultModelDefinition): string {
  return `${model.mode}-${model.pricing.mode}`
}
