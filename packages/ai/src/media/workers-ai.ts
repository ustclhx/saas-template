import { AppError } from '@saas/shared'
import type { MediaBinaryOutput, SyncMediaProvider } from './provider.ts'

export interface WorkersAiBinding {
  run(modelId: string, params: Record<string, unknown>): Promise<unknown>
}

export const WORKERS_AI_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'

function invalidOutput(): never {
  throw new AppError('WORKERS_AI_INVALID_RESPONSE', 'Invalid Workers AI image output', {
    status: 502,
  })
}

function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return 'image/png'
  const header = new TextDecoder().decode(bytes.subarray(0, 12))
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp'
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  return invalidOutput()
}

async function streamOutput(body: ReadableStream<Uint8Array>): Promise<MediaBinaryOutput> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let done = false
  try {
    // 不缓存整张图片；仅取足够的文件头辨识真实类型，余下内容交给存储的大小限制。
    while (length < 12 && !done) {
      const next = await reader.read()
      done = next.done
      if (next.value) {
        chunks.push(next.value)
        length += next.value.byteLength
      }
    }
    const prefix = new Uint8Array(Math.min(length, 12))
    let offset = 0
    for (const chunk of chunks) {
      const part = chunk.subarray(0, prefix.byteLength - offset)
      prefix.set(part, offset)
      offset += part.byteLength
      if (offset === prefix.byteLength) break
    }
    const mime = imageMime(prefix)
    return {
      mime,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          if (done) controller.close()
        },
        async pull(controller) {
          const next = await reader.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      }),
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
}

/** Flux 返回 base64 JPEG；SDXL 等模型返回图片流，格式以文件头为准。 */
export function createWorkersAiMediaProvider(options: {
  binding: WorkersAiBinding
  modelId: string
}): SyncMediaProvider {
  return {
    id: 'workers-ai',
    capabilities: { synchronous: true, idempotentSubmit: false },
    async run(input) {
      if (input.modelId !== options.modelId)
        throw new AppError('WORKERS_AI_INVALID_MODEL', 'Model does not match Workers AI instance')
      let response: unknown
      try {
        response = await options.binding.run(options.modelId, input.params)
      } catch {
        // 不传播绑定错误中的请求参数和上游详情。
        throw new AppError('WORKERS_AI_GENERATION_FAILED', 'Workers AI image generation failed', {
          status: 502,
        })
      }
      if (response instanceof ReadableStream)
        return { outputs: [await streamOutput(response)], usage: { images: 1 } }
      if (
        !response ||
        typeof response !== 'object' ||
        !('image' in response) ||
        typeof response.image !== 'string' ||
        !response.image
      )
        invalidOutput()
      let bytes: Uint8Array
      try {
        bytes = Uint8Array.from(atob(response.image), (char) => char.charCodeAt(0))
      } catch {
        return invalidOutput()
      }
      return { outputs: [{ body: bytes, mime: imageMime(bytes) }], usage: { images: 1 } }
    },
  }
}
