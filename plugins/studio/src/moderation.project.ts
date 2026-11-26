import type { StudioKind } from './kinds.ts'

export interface StudioPublishCheckInput {
  readonly title: string
  readonly prompt: string | null
  readonly kind: StudioKind
  readonly modelKey: string
  readonly workspaceId: string
}

export type StudioPublishCheckResult =
  | { action: 'allow' }
  | { action: 'review' }
  | { action: 'reject'; reason: string }

export async function checkPublish(
  _input: StudioPublishCheckInput,
): Promise<StudioPublishCheckResult> {
  return { action: 'allow' }
}
