import { linkOptions } from '@tanstack/react-router'
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
    label: ADMIN_COPY.nav.billing,
    activeOptions: { exact: true, includeSearch: false },
  },
  {
    to: '/admin/billing/refunds',
    search: { offset: 0 },
    label: ADMIN_COPY.nav.refunds,
    activeOptions: { includeSearch: false },
  },
  { to: '/admin/models', label: ADMIN_COPY.nav.models },
])
