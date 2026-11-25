import { getSettingDefinition, type JsonValue } from '@saas/db'
import { isSensitiveKey, REDACTED } from '@saas/shared'
import { auditSearchSchema, listAuditLogs } from '@web/features/admin/audit.ts'
import { ADMIN_MAX_OFFSET, ADMIN_PAGE_SIZE } from '@web/features/admin/list.ts'
import { metricsSearchSchema, readAdminMetrics } from '@web/features/admin/metrics.ts'
import { adminUserDetail, listAdminUsers } from '@web/features/admin/users.ts'
import {
  getAdminWorkspaceCreditLedger,
  listAdminWorkspaces,
} from '@web/features/admin/workspaces.ts'
import { listAdminPurchases } from '@web/features/billing/admin-data.ts'
import { requireFeature } from '@web/server/feature-gates.ts'
import { z } from 'zod'
import { defineAdminTool, toolResult } from './define.ts'

const page = z.object({
  offset: z.number().int().min(0).max(ADMIN_MAX_OFFSET).default(0),
  limit: z.number().int().min(1).max(ADMIN_PAGE_SIZE).default(ADMIN_PAGE_SIZE),
})

const usersSearch = defineAdminTool({
  name: 'users.search',
  scope: 'admin:read',
  description: 'List users, optionally matching their email, name, or ID',
  input: page.extend({ q: z.string().max(200).optional() }),
  run: async ({ db }, input) => toolResult(await listAdminUsers(db, input)),
})

const usersGet = defineAdminTool({
  name: 'users.get',
  scope: 'admin:read',
  description: 'Get a user and their workspace memberships and sign-in methods',
  input: z.object({ id: z.uuid() }),
  run: async ({ db }, { id }) => toolResult(await adminUserDetail(db, id)),
})

const workspacesList = defineAdminTool({
  name: 'workspaces.list',
  scope: 'admin:read',
  description: 'List workspaces, optionally filtering by name, slug, ID, or status',
  input: page.extend({
    q: z.string().max(200).optional(),
    status: z.enum(['active', 'deleted']).optional(),
  }),
  run: async ({ db }, input) => toolResult(await listAdminWorkspaces(db, input)),
})

const ordersList = defineAdminTool({
  name: 'orders.list',
  scope: 'admin:read',
  description: 'List one-time purchase orders across workspaces or for a selected workspace',
  input: page.extend({ workspaceId: z.uuid().optional() }),
  run: async ({ db }, input) => {
    requireFeature('billing')
    return toolResult(await listAdminPurchases(db, input))
  },
})

const creditsLedger = defineAdminTool({
  name: 'credits.ledger',
  scope: 'admin:read',
  description: 'List credit ledger entries for a selected workspace',
  input: page.extend({ workspaceId: z.uuid() }),
  run: async ({ db }, { workspaceId, ...input }) => {
    requireFeature('credits')
    const { items, nextCursor } = await getAdminWorkspaceCreditLedger(db, workspaceId, input)
    return toolResult({ rows: items, hasMore: nextCursor !== null })
  },
})

// 历史审计可能把设置值记在通用 oldValue/newValue 字段下，需结合设置定义脱敏。
function redactAuditMeta(meta: JsonValue, secretSetting: boolean, depth = 0): JsonValue {
  if (depth >= 8) return '[Truncated]'
  if (Array.isArray(meta))
    return meta.map((item) => redactAuditMeta(item, secretSetting, depth + 1))
  if (meta === null || typeof meta !== 'object') return meta
  const secret =
    secretSetting ||
    (typeof meta.key === 'string' && getSettingDefinition(meta.key)?.secret === true)
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => {
      const hide =
        isSensitiveKey(key) ||
        key.toLowerCase().replace(/[-_]/g, '') === 'tokenhash' ||
        getSettingDefinition(key)?.secret ||
        (secret && (key === 'oldValue' || key === 'newValue' || key === 'value'))
      return [key, hide ? REDACTED : redactAuditMeta(value, secret, depth + 1)]
    }),
  )
}

const auditList = defineAdminTool({
  name: 'audit.list',
  scope: 'admin:read',
  description: 'List audit entries and filter by actor, workspace, action, or inclusive UTC dates',
  input: auditSearchSchema.safeExtend({ limit: page.shape.limit }),
  run: async ({ db }, input) => {
    const { rows, hasMore } = await listAuditLogs(db, input)
    return toolResult({
      rows: rows.map(({ log, actorEmail }) => {
        const secret =
          log.targetType === 'setting' &&
          log.targetId !== null &&
          getSettingDefinition(log.targetId)?.secret === true
        return { actorEmail, log: { ...log, meta: redactAuditMeta(log.meta, secret) } }
      }),
      hasMore,
    })
  },
})

const metricsSummary = defineAdminTool({
  name: 'metrics.summary',
  scope: 'admin:read',
  description: 'Summarize business metrics over an inclusive UTC date range',
  input: metricsSearchSchema,
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
  auditList,
  metricsSummary,
] as const
