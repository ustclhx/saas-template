import type { ShareCardObjects } from '../share-cards.ts'

export function createCloudflareShareCardObjects(bucket: R2Bucket): ShareCardObjects {
  return {
    async list(input) {
      const page = await bucket.list(input)
      return {
        keys: page.objects.map((object) => object.key),
        ...(page.truncated ? { cursor: page.cursor } : {}),
      }
    },
    delete: (key) => bucket.delete(key),
  }
}
