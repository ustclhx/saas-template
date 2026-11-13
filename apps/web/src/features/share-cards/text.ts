// 中日韩字形、全角符号与谚文：按字宽 1 计；其余（拉丁、数字、半角标点）约 0.55。
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u

/** 文本是否含需要 CJK 字体的字符；渲染器据此决定是否加载完整 CJK 字体。 */
export function containsCjk(text: string): boolean {
  return WIDE.test(text)
}

export function charWidth(char: string): number {
  return WIDE.test(char) ? 1 : 0.55
}

export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/**
 * 按字宽加权截断，超出时以省略号结尾（省略号记 1 个字宽）。
 * satori 不支持 line-clamp，版式在渲染前截断，避免溢出被裁掉后看不到省略号。
 */
export function truncateText(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (textWidth(normalized) <= maxWidth) return normalized
  let width = 0
  let result = ''
  for (const char of normalized) {
    const next = width + charWidth(char)
    if (next > maxWidth - 1) break
    width = next
    result += char
  }
  return `${result.trimEnd()}…`
}
