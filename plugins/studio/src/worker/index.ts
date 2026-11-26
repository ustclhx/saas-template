import type { WorkerPluginModule } from '@web/server/cloudflare/plugins.ts'
import { registerStudioDeletionSteps } from '../web/works-delete-cleanup.ts'

export default {} satisfies WorkerPluginModule

registerStudioDeletionSteps()
