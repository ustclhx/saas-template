import type { AiModality } from './pricing.ts'

export interface FeatureModelDefinition {
  readonly kind: AiModality
  readonly inherit?: readonly string[]
}

export type FeatureModelDefinitions = Readonly<Record<string, FeatureModelDefinition>>

/** 登记时检查整个沿用图，解析时只读取各候选功能的显式设置。 */
export function defineFeatureModels<const T extends FeatureModelDefinitions>(definitions: T): T {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(feature: string) {
    if (visiting.has(feature)) throw new Error(`Feature model inheritance cycle: ${feature}`)
    if (visited.has(feature)) return

    visiting.add(feature)
    const definition = definitions[feature]
    if (!definition) throw new Error(`Unknown feature model: ${feature}`)
    for (const from of definition.inherit ?? []) {
      if (!Object.hasOwn(definitions, from)) {
        throw new Error(`Unknown feature model: ${feature} inherits ${from}`)
      }
      if (definitions[from]?.kind !== definition.kind) {
        throw new Error(`Feature model kind mismatch: ${feature} inherits ${from}`)
      }
      visit(from)
    }
    visiting.delete(feature)
    visited.add(feature)
  }

  for (const feature of Object.keys(definitions)) visit(feature)
  return definitions
}
