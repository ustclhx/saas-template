import type { StudioKind } from './kinds.ts'

export interface StudioPromptPreset {
  readonly id: string
  readonly name: string
  readonly mode: StudioKind
  readonly text: string
}

export const studioPromptPresets: readonly StudioPromptPreset[] = []
