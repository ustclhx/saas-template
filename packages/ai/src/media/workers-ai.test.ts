import { describe, expect, it, vi } from 'vitest'
import { createWorkersAiMediaProvider, WORKERS_AI_IMAGE_MODEL } from './workers-ai.ts'

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5])
const input = {
  modelId: WORKERS_AI_IMAGE_MODEL,
  params: { prompt: 'fixture' },
  idempotencyKey: 'task',
}

describe('Workers AI 图片 Provider', () => {
  it('将 Flux 官方 base64 结果解码为 JPEG 并报告一张图片用量', async () => {
    const binding = { run: vi.fn(async () => ({ image: btoa(String.fromCharCode(...jpeg)) })) }
    const provider = createWorkersAiMediaProvider({ binding, modelId: input.modelId })
    const result = await provider.run(input)
    expect(binding.run).toHaveBeenCalledWith(input.modelId, input.params)
    expect(result).toEqual({ outputs: [{ body: jpeg, mime: 'image/jpeg' }], usage: { images: 1 } })
  })

  it('辨识跨 chunk 的二进制流文件头并保留全部图片字节', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.subarray(0, 3))
        controller.enqueue(png.subarray(3))
        controller.close()
      },
    })
    const provider = createWorkersAiMediaProvider({
      binding: { run: async () => stream },
      modelId: input.modelId,
    })
    const result = await provider.run(input)
    expect(result.outputs[0]?.mime).toBe('image/png')
    const body = result.outputs[0]?.body
    if (!(body instanceof ReadableStream)) throw new Error('Expected binary output stream')
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(png)
    expect(result.usage).toEqual({ images: 1 })
  })

  it('拒绝非图片 / 非法 base64，绑定失败不泄露上游错误', async () => {
    for (const image of ['invalid base64!', btoa('upstream returned HTML')]) {
      const provider = createWorkersAiMediaProvider({
        binding: { run: async () => ({ image }) },
        modelId: input.modelId,
      })
      await expect(provider.run(input)).rejects.toMatchObject({
        code: 'WORKERS_AI_INVALID_RESPONSE',
      })
    }
    const failed = createWorkersAiMediaProvider({
      binding: {
        run: async () => {
          throw new Error('private upstream detail')
        },
      },
      modelId: input.modelId,
    })
    await expect(failed.run(input)).rejects.toMatchObject({
      code: 'WORKERS_AI_GENERATION_FAILED',
      message: 'Workers AI image generation failed',
    })
  })
})
