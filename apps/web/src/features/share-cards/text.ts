// 分享卡片文本：渲染前清理不支持的字符、判断是否需要回退字体、按字宽与换行截断。
// 字宽以 em 计，取略偏大的保守值，保证截断后的文字不会被版式的 max-height 裁掉省略号。

// 中日韩字形、全角符号：1em
const WIDE = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u

type Ranges = readonly (readonly [number, number])[]

// Inter Latin 子集（fontsource latin unicode-range）覆盖的码位；之外的字符需要 Noto Sans SC 回退。
// 用码位表而不是正则：区间含控制字符与组合附加符号，正则字符类会被 lint 拒绝。
const INTER_LATIN: Ranges = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
]

// Noto Sans SC（简体子集）在 U+0100–U+052F 内实际有字形的码位（由字体 cmap 导出）：
// 拼音声调字母、基本希腊字母、基本西里尔字母；其余扩展拉丁、带调希腊字母等没有字形。
const NOTO_EXTENDED: Ranges = [
  [0x0100, 0x0103],
  [0x0110, 0x0113],
  [0x011a, 0x011b],
  [0x0128, 0x012b],
  [0x0143, 0x0144],
  [0x0147, 0x0148],
  [0x014c, 0x014f],
  [0x0152, 0x0153],
  [0x0168, 0x016d],
  [0x0192, 0x0192],
  [0x01a0, 0x01a1],
  [0x01af, 0x01b0],
  [0x01cd, 0x01dc],
  [0x01f8, 0x01f9],
  [0x0251, 0x0251],
  [0x0261, 0x0261],
  [0x02bb, 0x02bb],
  [0x02c7, 0x02c7],
  [0x02c9, 0x02cb],
  [0x02d9, 0x02d9],
  [0x02ea, 0x02eb],
  [0x0300, 0x0301],
  [0x0304, 0x0304],
  [0x0307, 0x0307],
  [0x030c, 0x030c],
  [0x0391, 0x03a1],
  [0x03a3, 0x03a9],
  [0x03b1, 0x03c9],
  [0x0401, 0x0401],
  [0x0410, 0x044f],
  [0x0451, 0x0451],
]

function inRanges(char: string, ranges: Ranges): boolean {
  const code = char.codePointAt(0) ?? -1
  return ranges.some(([from, to]) => code >= from && code <= to)
}

// 两种字体都没有字形的文字（谚文、泰文等）：加载 Noto 也无济于事，见文档中的已知限制。
const UNSUPPORTED_SCRIPT =
  /[\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

// 没有 emoji 字体：去掉 emoji 及组合用的 ZWJ、变体选择符、肤色修饰、区域旗帜、键帽与标签字符。
const EMOJI_SOURCE =
  '\\p{Extended_Pictographic}|[\\u200d\\ufe0e\\ufe0f\\u20e3]|[\\u{1f3fb}-\\u{1f3ff}]|[\\u{1f1e6}-\\u{1f1ff}]|[\\u{e0020}-\\u{e007f}]'
const EMOJI_ALL = new RegExp(EMOJI_SOURCE, 'gu')

const EXTENDED_RANGE = /[\u0100-\u052f]/gu

const covered = (char: string) => inRanges(char, INTER_LATIN) || inRanges(char, NOTO_EXTENDED)

/** 两种字体都没有的扩展拉丁 / 希腊 / 西里尔字母去掉附加符号（Ą→A、ά→α），去掉后仍无字形则保留原字。 */
function foldUncovered(char: string): string {
  if (covered(char)) return char
  const base = char.normalize('NFD').replace(/\p{M}/gu, '')
  return base !== '' && [...base].every(covered) ? base : char
}

/** 清理 emoji 等无法渲染的字符、为缺字的带附加符号字母降级，并折叠空白。 */
export function sanitizeText(text: string): string {
  return text
    .replace(EMOJI_ALL, '')
    .replace(EXTENDED_RANGE, foldUncovered)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 文本是否含 Inter Latin 子集之外、且 Noto Sans SC 能显示的字符（CJK、西里尔、希腊、扩展拉丁等）。
 * 谚文、泰文等两种字体都不支持的文字不触发加载。
 */
export function needsFallbackFont(text: string): boolean {
  for (const char of sanitizeText(text)) {
    if (!inRanges(char, INTER_LATIN) && !UNSUPPORTED_SCRIPT.test(char)) return true
  }
  return false
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

/** 单个字素的字宽（em）：CJK 与省略号 1、拉丁大写 0.72、空格 0.3、其余 0.6。 */
export function charWidth(char: string): number {
  if (WIDE.test(char) || char === '…') return 1
  if (char === ' ') return 0.3
  return /^\p{Lu}/u.test(char) ? 0.72 : 0.6
}

export function textWidth(text: string): number {
  let width = 0
  for (const char of graphemes(text)) width += charWidth(char)
  return width
}

const isWide = (char: string) => WIDE.test(char)
const isWordChar = (char: string | undefined) =>
  char !== undefined && !isWide(char) && /^[\p{L}\p{N}]/u.test(char)

/**
 * 模拟换行（拉丁按空格断行，CJK 逐字可断），返回占用的行数。
 * 没有断点的超长单词按字断开。
 */
export function countLines(text: string, lineWidth: number): number {
  const chars = graphemes(text)
  let lines = 1
  let width = 0
  // 当前行最后一个可断点之后的宽度
  let sinceBreak = 0
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string
    const w = charWidth(char)
    if (char === ' ') {
      if (width === 0) continue
      width += w
      sinceBreak = 0
      continue
    }
    if (isWide(char) || !isWordChar(chars[i - 1])) sinceBreak = 0
    if (width + w > lineWidth && width > 0) {
      lines += 1
      // 在最后一个断点处换行，断点后的内容移到新行；没有断点时就地断开
      width = sinceBreak < width ? sinceBreak : 0
      sinceBreak = width
    }
    width += w
    sinceBreak += w
  }
  return lines
}

export interface ClampOptions {
  /** 加权字宽上限（em）。 */
  readonly maxWidth: number
  /** 可选：行宽（em）与最多行数，按换行模拟确保省略号所在的行不被裁掉。 */
  readonly lineWidth?: number
  readonly lines?: number
}

/**
 * 按字宽加权截断，超出时以省略号结尾；拉丁文本退回到词边界，不拆单词。
 * 版式在渲染前截断，satori 的 lineClamp 只作兜底。
 */
export function truncateText(text: string, limit: number | ClampOptions): string {
  const options = typeof limit === 'number' ? { maxWidth: limit } : limit
  const normalized = sanitizeText(text)
  const fits = (candidate: string) =>
    textWidth(candidate) <= options.maxWidth &&
    (options.lineWidth === undefined ||
      countLines(candidate, options.lineWidth) <= (options.lines ?? 1))
  if (fits(normalized)) return normalized
  // 只看前 200 个字素：远超版式容量的输入不必逐一尝试
  const chars = graphemes(normalized).slice(0, 200)
  const clip = (end: number) =>
    chars
      .slice(0, end)
      .join('')
      .replace(/[\s,.;:!?、，。；：·\-–—]+$/u, '')
  let end = chars.length
  while (end > 0 && !fits(`${clip(end)}…`)) end -= 1
  // 拉丁单词被截断时退回到上一个空格，但至少保留一半内容
  if (isWordChar(chars[end - 1]) && isWordChar(chars[end])) {
    const space = chars.lastIndexOf(' ', end - 1)
    if (space > end / 2) end = space
  }
  return `${clip(end)}…`
}
