export const STUDIO_MEDIA_PREFIX = '/media/w/'

export function studioMediaPath(workId: string, version: number): string {
  return `${STUDIO_MEDIA_PREFIX}${workId.toLowerCase()}/${version}`
}
