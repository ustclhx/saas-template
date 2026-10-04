import { env } from 'cloudflare:workers'
import { deleteAccount, deleteTeamWorkspace } from '@saas/auth'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { getAuth } from '../../server/auth.ts'

async function remove(workspaceId?: string) {
  const db = createDb(env.HYPERDRIVE)
  const options = { db, auth: getAuth(env, db), headers: getRequest().headers, kv: env.CACHE }
  try {
    if (workspaceId) await deleteTeamWorkspace({ ...options, workspaceId })
    else await deleteAccount(options)
    return { ok: true as const }
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    return {
      ok: false as const,
      code: error.code,
      message: error.message,
      workspaces: (error.details?.workspaces ?? []) as { id: string; name: string; slug: string }[],
    }
  }
}
export const removeAccount = createServerFn({ method: 'POST' }).handler(() => remove())
export const removeWorkspace = createServerFn({ method: 'POST' })
  .validator(z.object({ workspaceId: z.uuid() }))
  .handler(({ data }) => remove(data.workspaceId))
