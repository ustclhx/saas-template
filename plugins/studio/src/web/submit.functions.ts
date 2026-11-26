import {
  getFileMediaHttpDeps,
  getWorkspaceMediaSubmitOptions,
} from '@saas/plugin-media/submit.server'
import { AppError, parseInsufficientCredits } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'
import { sessionFaultAccess } from '@web/features/ai/fault-access.ts'
import { withBilling } from '@web/server/feature-gates.ts'
import { withWorkspace } from '@web/server/middleware.ts'
import { getWebRuntime, pluginUnavailable } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { z } from 'zod'
import { enabledStudioKinds, STUDIO_KINDS } from '../kinds.ts'
import { studioPromptPresets } from '../studio.project.ts'
import { requireStudioMode, studioModelSchema, submitStudioCreation } from './submit.server.ts'

function requireStudioRuntime() {
  const runtime = getWebRuntime()
  if (pluginUnavailable(runtime, 'studio') || pluginUnavailable(runtime, 'media'))
    throw new AppError('STUDIO_UNAVAILABLE', 'Studio is unavailable', { status: 503 })
}

export const getStudioSubmitPage = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(
    z.strictObject({ slug: z.string().min(1).max(64), mode: z.enum(STUDIO_KINDS).optional() }),
  )
  .handler(async ({ context, data }) => {
    try {
      const kinds = enabledStudioKinds(templateConfig)
      if (data.mode !== undefined) requireStudioMode(templateConfig, data.mode)
      if (kinds.length === 0)
        throw new AppError('NOT_FOUND', 'Studio is unavailable', { status: 404 })
      requireStudioRuntime()
      const modes = data.mode === undefined ? kinds : [data.mode]
      const options = await getWorkspaceMediaSubmitOptions(context, getRequest().headers, (model) =>
        modes.some((mode) => studioModelSchema(model, mode) !== null),
      )
      return {
        ...options,
        kinds,
        presets: studioPromptPresets.filter(({ mode }) => modes.includes(mode)),
        files: options.files.filter(({ mime }) => mime.startsWith('image/')),
      }
    } catch (error) {
      if (error instanceof AppError) setResponseStatus(error.status)
      throw error
    }
  })

export const submitStudio = createServerFn({ method: 'POST' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(
    z.strictObject({
      slug: z.string().min(1).max(64),
      mode: z.enum(STUDIO_KINDS),
      modelKey: z.string().min(1).max(128),
      prompt: z.string().refine((prompt) => prompt.trim().length > 0),
      presetId: z.string().min(1).optional(),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    }),
  )
  .handler(async ({ context, data }) => {
    try {
      const task = await submitStudioCreation(data, context, {
        config: templateConfig,
        presets: studioPromptPresets,
        mediaDeps: () => {
          requireStudioRuntime()
          const deps = getFileMediaHttpDeps()
          return {
            ...deps,
            callbackOrigin: new URL(deps.env.APP_URL).origin,
            faultAccess: sessionFaultAccess(context, deps.env),
          }
        },
      })
      return { ok: true as const, ...task }
    } catch (error) {
      if (!(error instanceof AppError) || !error.expose) throw error
      setResponseStatus(error.status)
      const credits = parseInsufficientCredits(error)
      const field = error.publicDetails?.field
      return {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
          details: credits ?? (typeof field === 'string' ? { field } : undefined),
        },
      }
    }
  })
