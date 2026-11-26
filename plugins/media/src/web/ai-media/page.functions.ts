import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { withBilling } from '@web/server/feature-gates.ts'
import { withWorkspace } from '@web/server/middleware.ts'
import { z } from 'zod'
import { getWorkspaceMediaSubmitOptions } from '../submit.server.ts'

export const getMediaSubmitPage = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(z.object({ slug: z.string().min(1).max(64) }))
  .handler(({ context }) => getWorkspaceMediaSubmitOptions(context, getRequest().headers))
