import { createFileRoute } from '@tanstack/react-router'
import { healthResponse } from '../../server/health.ts'
import { getWebRuntime } from '../../server/runtime.ts'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => healthResponse({ database: () => getWebRuntime().db, version: __APP_VERSION__ }),
    },
  },
})
