import type { AvailableModel } from '@saas/ai'
import { parseMediaSchema } from '@saas/ai/client'
import { submitWorkspaceMedia, type WorkspaceMediaDeps } from '@saas/plugin-media/submit.server'
import { AppError } from '@saas/shared'
import type { ResolvedWorkspace } from '@web/server/workspace-context.ts'
import { enabledStudioKinds, type StudioKind } from '../kinds.ts'
import type { StudioPromptPreset } from '../studio.project.ts'

export interface StudioCreationInput {
  mode: StudioKind
  modelKey: string
  prompt: string
  presetId?: string | undefined
  params: Record<string, string | number | boolean>
}

type StudioConfig = Parameters<typeof enabledStudioKinds>[0]

export function requireStudioMode(config: StudioConfig, mode: StudioKind) {
  if (!enabledStudioKinds(config).includes(mode))
    throw new AppError('NOT_FOUND', 'Studio mode is unavailable', { status: 404 })
}

/** 列表与提交用同一规则，只有能接收文本提示词的模型才能在 Studio 使用。 */
export function studioModelSchema(model: AvailableModel, mode: StudioKind) {
  if (model.kind !== mode || model.paramsSchema === null) return null
  try {
    const schema = parseMediaSchema(model.paramsSchema)
    const prompt = schema.properties.prompt
    return prompt?.type === 'string' && prompt.format === undefined ? schema : null
  } catch (error) {
    if (error instanceof AppError && error.code === 'MEDIA_SCHEMA_INVALID') return null
    throw error
  }
}

export async function submitStudioCreation(
  input: StudioCreationInput,
  workspace: ResolvedWorkspace & { workspaceReadOnly: boolean },
  options: {
    config: StudioConfig
    presets: readonly StudioPromptPreset[]
    mediaDeps: () => WorkspaceMediaDeps
  },
) {
  requireStudioMode(options.config, input.mode)
  if (workspace.workspaceReadOnly)
    throw new AppError('WORKSPACE_READ_ONLY', 'Workspace is read-only', { status: 403 })

  let prompt = input.prompt
  if (input.presetId !== undefined) {
    const preset = options.presets.find(
      ({ id, mode }) => id === input.presetId && mode === input.mode,
    )
    if (!preset) throw new AppError('STUDIO_PRESET_UNAVAILABLE', 'Prompt preset is unavailable')
    prompt = `${prompt}\n${preset.text}`
  }

  const task = await submitWorkspaceMedia(
    { modelKey: input.modelKey, params: input.params, userPrompt: input.prompt },
    workspace,
    {
      ...options.mediaDeps(),
      prepareParams(model, params) {
        const schema = studioModelSchema(model, input.mode)
        if (!schema)
          throw new AppError('MODEL_UNAVAILABLE', 'Studio model is unavailable', { status: 404 })
        for (const field of schema.required) {
          if (
            schema.properties[field]?.format === 'file' &&
            (params[field] === undefined || params[field] === '')
          )
            throw new AppError('STUDIO_REFERENCE_REQUIRED', 'A reference image is required', {
              publicDetails: { field },
            })
        }
        return { ...params, prompt }
      },
      validateInputFile(file, field) {
        if (!file.mime.startsWith('image/'))
          throw new AppError('STUDIO_REFERENCE_INVALID', 'Expected a reference image', {
            publicDetails: { field },
          })
      },
    },
  )
  return { taskId: task.id, status: task.status }
}
