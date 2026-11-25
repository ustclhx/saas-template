import type { ShareCardObjects } from '../share-cards.ts'
import { withR2Retry } from './retry.ts'

export function createCloudflareShareCardObjects(bucket: R2Bucket): ShareCardObjects {
  return {
    async list(input) {
      const page = await bucket.list(input)
      return {
        keys: page.objects.map((object) => object.key),
        ...(page.truncated ? { cursor: page.cursor } : {}),
      }
    },
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return null
      return {
        body: new Uint8Array(await object.arrayBuffer()),
        metadata: object.customMetadata ?? {},
      }
    },
    async put(key, body, options = {}) {
      // body 为 Uint8Array，可重放。
      await withR2Retry('put', () =>
        bucket.put(key, body, {
          ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
          ...(options.metadata ? { customMetadata: options.metadata } : {}),
        }),
      )
    },
    delete: (key) => withR2Retry('delete', () => bucket.delete(key)),
  }
}
