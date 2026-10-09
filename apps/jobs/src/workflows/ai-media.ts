import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { createTaskMediaProvider, readMediaTaskInput } from '@saas/ai'
import { MEDIA_MAX_FILE_BYTES, MEDIA_OUTPUT_HOSTS, MEDIA_OUTPUT_MIME_TYPES } from '@saas/config'
import { createDb } from '@saas/db'
import { getEntitlements } from '@saas/entitlements'
import { newRequestId, withLogContext } from '@saas/shared/log'
import { getFileDownload, persistMediaOutputs } from '@saas/storage'
import templateConfig from '../../../../template.config.ts'
import { runMediaTask } from './media-runner.ts'

export interface AiMediaParams {
  taskId: string
  requestId?: string
}

export class AiMediaWorkflow extends WorkflowEntrypoint<Cloudflare.Env, AiMediaParams> {
  override run(event: WorkflowEvent<AiMediaParams>, step: WorkflowStep) {
    return withLogContext(
      { requestId: event.payload.requestId ?? newRequestId(), taskId: event.payload.taskId },
      async () => {
        const db = createDb(this.env.HYPERDRIVE)
        return runMediaTask(event.payload.taskId, step, {
          db,
          callbackOrigin: templateConfig.app.url,
          callbackSecret: this.env.MEDIA_WEBHOOK_SECRET ?? '',
          provider: (task) => createTaskMediaProvider(this.env, task),
          params: async (task) => {
            const input = readMediaTaskInput(task)
            const params = { ...input.params }
            for (const name of input.fileParams) {
              params[name] = await getFileDownload(db, this.env, {
                workspaceId: task.workspaceId,
                fileId: input.params[name] as string,
              })
            }
            return params
          },
          nonRetryable: (message) => new NonRetryableError(message),
          persist: async (task, result) => {
            const entitlements = await getEntitlements(db, task.workspaceId, {
              pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
            })
            return persistMediaOutputs({
              db,
              bucket: this.env.FILES,
              task,
              result,
              limits: {
                maxFileBytes: MEDIA_MAX_FILE_BYTES,
                allowedHosts: MEDIA_OUTPUT_HOSTS[task.provider] ?? [],
                allowedMimeTypes: MEDIA_OUTPUT_MIME_TYPES[task.kind],
                storageBytes: Math.min(
                  readMediaTaskInput(task).storageBytes,
                  entitlements.features.storageGb * 1024 ** 3,
                ),
              },
            })
          },
        })
      },
    )
  }
}
