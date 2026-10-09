/** fal 官方模型 API 示例与现有夹具使用的产出主机；只允许精确主机名。 */
export const MEDIA_OUTPUT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  fal: ['fal.media', 'v3.fal.media', 'v3b.fal.media'],
}

export const MEDIA_MAX_FILE_BYTES = 100 * 1024 * 1024
export const MEDIA_OUTPUT_MIME_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm'],
} as const
