import { createFileRoute } from '@tanstack/react-router'
import { getWebRuntime } from '@web/server/runtime.ts'
import { respondToAdminMcp } from '../../../src/web/mcp.ts'

export const Route = createFileRoute('/api/admin/mcp')({
  server: {
    handlers: {
      ANY: ({ request }) => respondToAdminMcp(request, getWebRuntime),
    },
  },
})
