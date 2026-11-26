import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Storage } from '../storage.ts'
import {
  createS3Client,
  isMissing,
  type S3StorageConfig,
  storageError,
  validateKey,
} from './client.ts'
import { createNodeShareCardObjects } from './share-cards.ts'

export type { S3StorageConfig } from './client.ts'
export { createNodeMediaCopier } from './media.ts'

/** 单次操作释放 SDK 连接；适配器可在 web/jobs composition 中安全复用。 */
export function createNodeStorage(config: S3StorageConfig): Storage {
  async function operation<T>(
    key: string,
    code: string,
    run: (client: ReturnType<typeof createS3Client>) => Promise<T>,
  ) {
    validateKey(key)
    const client = createS3Client(config)
    try {
      return await run(client)
    } catch {
      throw storageError(code)
    } finally {
      client.destroy()
    }
  }

  return {
    shareCards: createNodeShareCardObjects(config),
    head: (key) =>
      operation(key, 'STORAGE_HEAD_FAILED', async (client) => {
        try {
          const result = await client.send(
            new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
          )
          return { size: result.ContentLength ?? 0, mime: result.ContentType ?? null }
        } catch (error) {
          if (isMissing(error)) return null
          throw error
        }
      }),
    async read(key, range) {
      validateKey(key)
      const client = createS3Client(config)
      try {
        const object = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
            ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}),
          }),
        )
        if (
          !(object.Body instanceof Readable) ||
          !object.ETag ||
          object.ContentLength === undefined
        ) {
          throw new Error('Incomplete S3 object response')
        }
        // Node 22 的默认策略按块计数，显式按字节限制缓冲区。
        const reader = Readable.toWeb(object.Body, {
          strategy: new ByteLengthQueuingStrategy({
            highWaterMark: object.Body.readableHighWaterMark,
          }),
        }).getReader()
        // SDK 请求在收到响应头时已返回，连接须等源流读完、取消或错误后再释放。
        const releaseClient = () => client.destroy()
        void reader.closed.then(releaseClient, releaseClient)
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (chunk.done) controller.close()
              else controller.enqueue(chunk.value)
            } catch {
              controller.error(storageError('STORAGE_READ_FAILED'))
            }
          },
          cancel: () => reader.cancel(),
        })
        return { body, etag: object.ETag, size: object.ContentLength }
      } catch (error) {
        client.destroy()
        if (isMissing(error)) return null
        throw storageError('STORAGE_READ_FAILED')
      }
    },
    delete: (key) =>
      operation(key, 'STORAGE_DELETE_FAILED', async (client) => {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      }),
    presignUpload: (key, mime) =>
      operation(key, 'STORAGE_SIGN_FAILED', async (client) => {
        const headers = { 'Content-Type': mime, 'If-None-Match': '*' }
        return {
          uploadUrl: await getSignedUrl(
            client,
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: key,
              ContentType: mime,
              IfNoneMatch: '*',
            }),
            {
              expiresIn: 600,
              signableHeaders: new Set(['content-type', 'if-none-match']),
            },
          ),
          headers,
          expiresIn: 600,
        }
      }),
    presignDownload: (key, attachment = false) =>
      operation(key, 'STORAGE_SIGN_FAILED', (client) =>
        getSignedUrl(
          client,
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
            ...(attachment ? { ResponseContentDisposition: 'attachment' } : {}),
          }),
          { expiresIn: 300 },
        ),
      ),
  }
}
