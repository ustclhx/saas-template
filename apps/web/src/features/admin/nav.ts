import { linkOptions } from '@tanstack/react-router'
import { templateConfig } from '../../server/template-config.ts'
import { ADMIN_COPY } from './copy.ts'

/**
 * 后台侧栏导航（add-admin-console tasks.md 1.3）。新增后台页面时在这里加一项；
 * 列表页的分页与筛选放在 search 参数中，入口链接从第一页开始。
 */
export const ADMIN_NAV = linkOptions([
  { to: '/admin', label: ADMIN_COPY.nav.overview, activeOptions: { exact: true } },
  {
    to: '/admin/billing',
    search: { offset: 0 },
    label: 'Payments',
    activeOptions: { exact: true, includeSearch: false },
  },
  {
    to: '/admin/billing/plans',
    search: { offset: 0 },
    label: 'Plan model access',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/billing/refunds',
    search: { offset: 0 },
    label: ADMIN_COPY.nav.refunds,
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/users',
    search: { offset: 0 },
    label: 'Users',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/workspaces',
    search: { offset: 0 },
    label: 'Workspaces',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/models',
    search: { offset: 0 },
    label: ADMIN_COPY.nav.models,
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/audit',
    search: { offset: 0 },
    label: 'Audit log',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/metrics',
    search: { offset: 0 },
    label: 'Metrics',
    activeOptions: { includeSearch: false },
  },
  { to: '/admin/settings', label: 'Settings' },
  {
    to: '/admin/credits',
    search: { offset: 0 },
    label: 'Credit adjustments',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/billing/subscriptions',
    search: { offset: 0 },
    label: 'Subscriptions',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/billing/purchases',
    search: { offset: 0 },
    label: 'One-time purchases',
    activeOptions: { includeSearch: false },
  },
  {
    to: '/admin/billing/webhooks',
    search: { offset: 0 },
    label: 'Webhook events',
    activeOptions: { includeSearch: false },
  },
  ...(templateConfig.features.waitlist
    ? [{ to: '/admin/waitlist' as const, search: { offset: 0 }, label: 'Waitlist' }]
    : []),
])
