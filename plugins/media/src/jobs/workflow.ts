import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import {
  createTaskMediaProvider,
  getMediaOutputHosts,
  type MediaRuntimeEnv,
  mediaAttemptRequest,
  readMediaTaskInput,
} from '@saas/ai'
import { getMediaProviders, MEDIA_MAX_FILE_BYTES, MEDIA_OUTPUT_MIME_TYPES } from '@saas/config'
import { createDb } from '@saas/db'
import { getEntitlements } from '@saas/entitlements'
import { createCloudflareWorkflowStep } from '@saas/platform/cloudflare'
import { type JobObserver, newRequestId, withLogContext } from '@saas/shared/log'
import { getFileDownload, persistMediaOutputs } from '@saas/storage'
import {
  createCloudflareMediaCopier,
  createCloudflareStorage,
  type StorageEnv,
} from '@saas/storage/cloudflare'
import { type CloudflareOptions, instrumentWorkflowWithSentry } from '@sentry/cloudflare'
import templateConfig from '../../../../template.config.ts'
import { type AiMediaParams, runMediaTask } from './media-runner.ts'

interface MediaWorkflowEnv extends MediaRuntimeEnv, StorageEnv {
  HYPERDRIVE: Hyperdrive
  AI_FAULT_INJECTION?: string
  SENTRY_DSN?: string
  SENTRY_ENVIRONMENT?: 'development' | 'staging' | 'production' | 'smoke'
  APP_VERSION?: string
}

interface WorkflowRuntime {
  requireEnv(env: unknown): void
  tagJobContext(): void
  sentryEnabled(env: MediaWorkflowEnv): boolean
  sentryOptions(env: MediaWorkflowEnv): CloudflareOptions
  createWorkflowSentry(
    step: WorkflowStep,
    sdkEnabled: boolean,
  ): { step: WorkflowStep; observer: JobObserver }
}

let runtime: WorkflowRuntime
export function configureWorker(context: WorkflowRuntime) {
  runtime = context
}

class AiMediaWorkflowBase extends WorkflowEntrypoint<MediaWorkflowEnv, AiMediaParams> {
  override run(event: WorkflowEvent<AiMediaParams>, step: WorkflowStep) {
    return withLogContext(
      { requestId: event.payload.requestId ?? newRequestId(), taskId: event.payload.taskId },
      async () => {
        runtime.tagJobContext()
        const workflowSentry = runtime.createWorkflowSentry(step, runtime.sentryEnabled(this.env))
        try {
          runtime.requireEnv(this.env)
          const db = createDb(this.env.HYPERDRIVE)
          const workflowStep = createCloudflareWorkflowStep(workflowSentry.step)
          return await runMediaTask(event.payload.taskId, workflowStep, {
            db,
            faultEnv: this.env,
            callbackOrigin: templateConfig.app.url,
            callbackSecret: this.env.MEDIA_WEBHOOK_SECRET ?? '',
            provider: (task) =>
              createTaskMediaProvider(this.env, task, getMediaProviders(templateConfig)),
            params: async (task) => {
              // 当前尝试的参数：切换后为备用模型按 paramMap 改名并校验过的副本。
              const input = mediaAttemptRequest(task)
              const params = { ...input.params }
              for (const name of input.fileParams) {
                params[name] = await getFileDownload(db, createCloudflareStorage(this.env), {
                  workspaceId: task.workspaceId,
                  fileId: input.params[name] as string,
                })
              }
              return params
            },
            observer: workflowSentry.observer,
            persist: async (task, result) => {
              const entitlements = await getEntitlements(db, task.workspaceId, {
                pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
              })
              return persistMediaOutputs({
                db,
                storage: createCloudflareStorage(this.env),
                copyOutput: createCloudflareMediaCopier(this.env.FILES),
                task,
                result,
                limits: {
                  maxFileBytes: MEDIA_MAX_FILE_BYTES,
                  allowedHosts: getMediaOutputHosts(task.provider),
                  allowedMimeTypes: MEDIA_OUTPUT_MIME_TYPES[task.kind],
                  storageBytes: Math.min(
                    readMediaTaskInput(task).storageBytes,
                    entitlements.features.storageGb * 1024 ** 3,
                  ),
                },
              })
            },
          })
        } catch (error) {
          workflowSentry.observer.captureException(error)
          throw error
        }
      },
    )
  }
}

const InstrumentedAiMediaWorkflow = instrumentWorkflowWithSentry(
  (env) => runtime.sentryOptions(env),
  AiMediaWorkflowBase,
)

// Workflow 包装器在构造时绑定环境；禁用时直接构造原始类，避免 run 初始化 SDK。
export const AiMediaWorkflow = new Proxy(AiMediaWorkflowBase, {
  construct(target, args, newTarget) {
    const env = args[1] as MediaWorkflowEnv
    return Reflect.construct(
      runtime.sentryEnabled(env) ? InstrumentedAiMediaWorkflow : target,
      args,
      newTarget,
    )
  },
})
