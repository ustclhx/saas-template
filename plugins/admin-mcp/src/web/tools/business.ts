import { auditSearchSchema, listAuditLogs } from '@web/features/admin/audit.ts'
import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { metricsSearchSchema, readAdminMetrics } from '@web/features/admin/metrics.ts'
import { adminUserDetail, listAdminUsers } from '@web/features/admin/users.ts'
import {
  getAdminWorkspaceCreditLedger,
  listAdminWorkspaceCreditGrants,
  listAdminWorkspaces,
} from '@web/features/admin/workspaces.ts'
import { listAdminPurchases } from '@web/features/billing/admin-data.ts'
import { requireFeature } from '@web/server/feature-gates.ts'
import { z } from 'zod'
import { auditRows } from './audit.ts'
import { defineAdminTool, pagingDescriptions, toolResult } from './define.ts'

const page = z.object({
  offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
  limit: z.number().int().min(1).max(ADMIN_PAGE_SIZE).default(ADMIN_PAGE_SIZE),
})

const usersSearch = defineAdminTool({
  name: 'users.search',
  scope: 'admin:read',
  description: 'List users, optionally matching their email, name, or ID.',
  input: page.extend({ q: z.string().max(200).optional() }),
  params: { ...pagingDescriptions, q: 'Search for a user by email, name, or ID.' },
  run: async ({ db }, input) => toolResult(await listAdminUsers(db, input)),
})

const usersGet = defineAdminTool({
  name: 'users.get',
  scope: 'admin:read',
  description: 'Get a user and their workspace memberships and sign-in methods.',
  input: z.object({ id: z.uuid() }),
  params: { id: 'UUID of the user to look up.' },
  run: async ({ db }, { id }) => toolResult(await adminUserDetail(db, id)),
})

const workspacesList = defineAdminTool({
  name: 'workspaces.list',
  scope: 'admin:read',
  description: 'List workspaces, optionally filtering by name, slug, ID, or status.',
  input: page.extend({
    q: z.string().max(200).optional(),
    status: z.enum(['active', 'deleted']).optional(),
  }),
  params: {
    ...pagingDescriptions,
    q: 'Search for a workspace by name, slug, or ID.',
    status: 'Filter for active or soft-deleted workspaces (active or deleted).',
  },
  run: async ({ db }, input) => toolResult(await listAdminWorkspaces(db, input)),
})

const ordersList = defineAdminTool({
  name: 'orders.list',
  scope: 'admin:read',
  description: 'List one-time purchase orders across workspaces or for a selected workspace.',
  input: page.extend({ workspaceId: z.uuid().optional() }),
  params: { ...pagingDescriptions, workspaceId: 'UUID of the workspace to filter orders by.' },
  run: async ({ db }, input) => {
    requireFeature('billing')
    return toolResult(await listAdminPurchases(db, input))
  },
})

const creditsLedger = defineAdminTool({
  name: 'credits.ledger',
  scope: 'admin:read',
  description:
    'List credit ledger entries for a selected workspace. Each entry includes the grantId of the credit batch it belongs to, if any.',
  input: page.extend({ workspaceId: z.uuid() }),
  params: { ...pagingDescriptions, workspaceId: 'UUID of the workspace whose ledger to read.' },
  run: async ({ db }, { workspaceId, ...input }) => {
    requireFeature('credits')
    const { items, nextCursor } = await getAdminWorkspaceCreditLedger(db, workspaceId, input)
    return toolResult({ rows: items, hasMore: nextCursor !== null })
  },
})

const creditsGrants = defineAdminTool({
  name: 'credits.grants',
  scope: 'admin:read',
  description:
    'List credit batches (grants) for a selected workspace with their remaining credits and status. Use the batch id as grantId when revoking with credits.adjust.',
  input: page.extend({
    workspaceId: z.uuid(),
    status: z.enum(['active', 'expired', 'revoked']).optional(),
  }),
  params: {
    ...pagingDescriptions,
    workspaceId: 'UUID of the workspace whose credit batches to read.',
    status: 'Filter batches by status (active, expired, or revoked).',
  },
  run: async ({ db }, { workspaceId, ...input }) => {
    requireFeature('credits')
    return toolResult(await listAdminWorkspaceCreditGrants(db, workspaceId, input))
  },
})

const auditList = defineAdminTool({
  name: 'audit.list',
  scope: 'admin:read',
  description: 'List audit entries and filter by actor, workspace, action, or inclusive UTC dates.',
  input: auditSearchSchema.safeExtend({ limit: page.shape.limit }),
  params: {
    ...pagingDescriptions,
    actor: 'Filter by actor email or user ID.',
    workspaceId: 'UUID of the workspace to filter audit entries by.',
    action: 'Filter by audit action name, such as setting.updated.',
    from: 'First UTC date to include, in YYYY-MM-DD format.',
    to: 'Last UTC date to include, in YYYY-MM-DD format.',
  },
  run: async ({ db }, input) => {
    const { rows, hasMore } = await listAuditLogs(db, input)
    return toolResult({ rows: auditRows(rows), hasMore })
  },
})

const metricsSummary = defineAdminTool({
  name: 'metrics.summary',
  scope: 'admin:read',
  description: 'Summarize business metrics over an inclusive UTC date range.',
  input: metricsSearchSchema,
  params: {
    from: 'First UTC date to include (YYYY-MM-DD). Defaults to six days before the end date.',
    to: 'Last UTC date to include (YYYY-MM-DD). Defaults to yesterday in UTC.',
  },
  run: async ({ db }, input) => {
    const { rows, latest, ...summary } = await readAdminMetrics(db, input)
    return toolResult({
      ...summary,
      dayCount: rows.length,
      latest: latest && {
        paidWorkspaces: latest.paidWorkspaces,
        mrrByCurrency: latest.mrrByCurrency,
        dataThrough: latest.dataThrough,
        computedAt: latest.computedAt,
      },
    })
  },
})

export const businessTools = [
  usersSearch,
  usersGet,
  workspacesList,
  ordersList,
  creditsLedger,
  creditsGrants,
  auditList,
  metricsSummary,
] as const
