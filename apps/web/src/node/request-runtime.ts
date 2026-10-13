import { AppError } from '@saas/shared'
import { getLogContext } from '@saas/shared/log'
import type { Storage } from '@saas/storage'
import type { WebRuntime } from '../server/runtime.ts'
import { captureNodeError, type NodeWebObserver } from './observer-context.ts'

// Nitro 与 Start 分别构建，资源由 HTTP 入口创建并经原始 Request 显式交给 SSR。
const key = Symbol.for('saas.web.runtime')
type ErrorSummary = { code: string; message: string; status: number }
const errorKey = Symbol.for('saas.node.errorSummary')
type RuntimeRequest = Request & {
  [key]?: WebRuntime
  [errorKey]?: (error: unknown) => ErrorSummary | undefined
}

export function attachWebRuntime(request: Request, runtime: WebRuntime) {
  ;(request as RuntimeRequest)[key] = runtime
  // 在资源所属 bundle 内验证错误类型；SSR 不按可伪造的 code/status 字段识别外部异常。
  ;(request as RuntimeRequest)[errorKey] = (error) =>
    error instanceof AppError
      ? { code: error.code, message: error.message, status: error.status }
      : undefined
}

export function requestWebRuntime(request: Request): WebRuntime {
  const runtime = (request as RuntimeRequest)[key]
  if (!runtime) throw new Error('Missing Node request runtime')
  const observer = runtime.observability as
    | Pick<NodeWebObserver, 'enabled' | 'captureError'>
    | undefined
  const describe = (request as RuntimeRequest)[errorKey]
  async function resourceCall<T>(handle: () => Promise<T>): Promise<T> {
    try {
      return await handle()
    } catch (error) {
      const summary = describe?.(error)
      if (summary) throw new AppError(summary.code, summary.message, { status: summary.status })
      throw error
    }
  }
  const storage = runtime.files?.available ? runtime.files.value : undefined
  const files: Storage | undefined = storage
    ? {
        head: (key) => resourceCall(() => storage.head(key)),
        delete: (key) => resourceCall(() => storage.delete(key)),
        presignUpload: (key, mime) => resourceCall(() => storage.presignUpload(key, mime)),
        presignDownload: (key, attachment) =>
          resourceCall(() => storage.presignDownload(key, attachment)),
      }
    : undefined
  const ai = runtime.ai?.available ? runtime.ai.value : undefined
  const download = ai?.downloadFile.available ? ai.downloadFile.value : undefined
  // 复制属性描述符保留惰性 getter 和 own/enumerable，文件 handler 的依赖展开才能保留 db/auth。
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(runtime),
      ...(files ? { files: { enumerable: true, value: { available: true, value: files } } } : {}),
      ...(ai && download
        ? {
            ai: {
              enumerable: true,
              value: {
                available: true,
                value: {
                  ...ai,
                  downloadFile: {
                    available: true,
                    value: (input: Parameters<typeof download>[0]) =>
                      resourceCall(() => download(input)),
                  },
                },
              },
            },
          }
        : {}),
      ...(observer
        ? {
            observability: {
              enumerable: true,
              value: {
                enabled: observer.enabled,
                captureError: (error: unknown) =>
                  captureNodeError(observer, error, getLogContext()),
              },
            },
          }
        : {}),
    },
  ) as WebRuntime
}
