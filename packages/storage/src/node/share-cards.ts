import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { AppError } from '@saas/shared'
import type { ShareCardObjects } from '../share-cards.ts'
import { createS3Client, type S3StorageConfig, storageError } from './client.ts'

export function createNodeShareCardObjects(config: S3StorageConfig): ShareCardObjects {
  async function operation<T>(
    key: string,
    run: (client: ReturnType<typeof createS3Client>) => Promise<T>,
  ) {
    // S3 使用字面对象键；列出的坏索引也必须能删除，不按文件系统路径拒绝点段。
    if (!key.startsWith('share-cards/'))
      throw new AppError('INVALID_SHARE_CARD_KEY', 'Invalid share card key')
    const client = createS3Client(config)
    try {
      return await run(client)
    } catch {
      throw storageError('SHARE_CARD_STORAGE_FAILED')
    } finally {
      client.destroy()
    }
  }
  return {
    list: (input) =>
      operation(input.prefix, async (client) => {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: input.prefix,
            ...(input.cursor ? { ContinuationToken: input.cursor } : {}),
            ...(input.limit ? { MaxKeys: input.limit } : {}),
          }),
        )
        return {
          keys: (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])),
          ...(page.IsTruncated && page.NextContinuationToken
            ? { cursor: page.NextContinuationToken }
            : {}),
        }
      }),
    delete: (key) =>
      operation(key, async (client) => {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      }),
  }
}
