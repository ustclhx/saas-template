import type { ShareCardObjects } from './share-cards.ts'

export interface StorageReadRange {
  readonly offset: number
  readonly length: number
}

export interface StorageReadResult {
  readonly body: ReadableStream<Uint8Array>
  readonly etag: string
  /** 返回的字节数，范围读取时为响应体长度。 */
  readonly size: number
}

/** C 的对象存储 adapter 接口；不暴露目标 SDK 的对象与元数据。 */
export interface Storage {
  readonly shareCards?: ShareCardObjects
  head(key: string): Promise<{ readonly size: number; readonly mime: string | null } | null>
  read?(key: string, range?: StorageReadRange): Promise<StorageReadResult | null>
  delete(key: string): Promise<void>
  presignUpload(
    key: string,
    mime: string,
  ): Promise<{
    readonly uploadUrl: string
    readonly headers: Readonly<Record<string, string>>
    readonly expiresIn: number
  }>
  presignDownload(key: string, attachment?: boolean): Promise<string>
}
