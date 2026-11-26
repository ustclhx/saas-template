import type { WebNodePluginModule } from '@web/node/plugins.ts'
import { registerStudioDeletionSteps } from '../web/works-delete-cleanup.ts'

export default {} satisfies WebNodePluginModule

registerStudioDeletionSteps()
