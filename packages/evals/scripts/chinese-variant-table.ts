/**
 * 生成 `src/chinese-variant-table.ts`（design D7 的简繁误用字表）。
 *
 * 用法（仓库根目录；Unihan.zip 取自 https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip 并解压）：
 *   node --experimental-strip-types packages/evals/scripts/chinese-variant-table.ts <Unihan 目录>
 *
 * 规则：
 * - 「仅简体」字 s：kTGH（《通用规范汉字表》）一级字（序号 ≤ 3500，常用字），有不同于自身的
 *   kTraditionalVariant，且没有 kGradeLevel（香港小学不教，繁体文本中不常用；
 *   Unihan 把「这」「会」等也列为自身的繁体异体，只按 kTraditionalVariant 会漏掉它们）；
 * - 「仅繁体」字 t：s 的 kTraditionalVariant 之一，kSimplifiedVariant 不含 t 本身，
 *   且 t 不在 kTGH 一级字中（排除简繁同形字）；
 * - 常用度：Unihan 已不再提供 kFrequency，改用 kGradeLevel（香港小学识字年级，越小越常用）
 *   为繁体字排序，同级按简体字的 kTGH 序号；取前 LIMIT 个繁体字及其对应简体字。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LIMIT = 500
const dir = process.argv[2]
if (!dir) {
  console.error('用法：chinese-variant-table.ts <Unihan 目录>')
  process.exit(2)
}

function fields(file: string, names: readonly string[]) {
  const out = new Map<string, Map<string, string>>()
  for (const name of names) out.set(name, new Map())
  let version = ''
  for (const line of readFileSync(join(dir as string, file), 'utf8').split('\n')) {
    const header = /^# Unicode Version (\S+)/.exec(line)
    if (header) version = header[1] as string
    if (!line.startsWith('U+')) continue
    const [code, field, value] = line.split('\t')
    const target = out.get(field as string)
    if (target && code && value)
      target.set(String.fromCodePoint(Number.parseInt(code.slice(2), 16)), value)
  }
  return { out, version }
}

const chars = (value: string | undefined) =>
  new Set(
    (value ?? '')
      .split(' ')
      .filter(Boolean)
      .map((code) => String.fromCodePoint(Number.parseInt(code.replace(/<.*$/, '').slice(2), 16))),
  )

const variants = fields('Unihan_Variants.txt', ['kTraditionalVariant', 'kSimplifiedVariant'])
const mappings = fields('Unihan_OtherMappings.txt', ['kTGH'])
const dictionary = fields('Unihan_DictionaryLikeData.txt', ['kGradeLevel'])
const traditionalOf = variants.out.get('kTraditionalVariant') as Map<string, string>
const simplifiedOf = variants.out.get('kSimplifiedVariant') as Map<string, string>
const tgh = new Map<string, number>()
for (const [char, value] of mappings.out.get('kTGH') as Map<string, string>) {
  const index = Math.min(...value.split(' ').map((item) => Number(item.split(':')[1])))
  tgh.set(char, index)
}
const grade = dictionary.out.get('kGradeLevel') as Map<string, string>

const common = (char: string) => (tgh.get(char) ?? Number.POSITIVE_INFINITY) <= 3500
const simplifiedOnly = (char: string) =>
  common(char) &&
  [...chars(traditionalOf.get(char))].some((form) => form !== char) &&
  !grade.has(char)
const traditionalOnly = (char: string) => {
  const forms = chars(simplifiedOf.get(char))
  return forms.size > 0 && !forms.has(char) && !common(char)
}

const candidates: { t: string; s: string; grade: number; index: number }[] = []
for (const [s, index] of tgh) {
  if (!simplifiedOnly(s)) continue
  for (const t of chars(traditionalOf.get(s))) {
    if (!traditionalOnly(t)) continue
    const level = Number(grade.get(t) ?? 9)
    candidates.push({ t, s, grade: level, index })
  }
}
candidates.sort((a, b) => a.grade - b.grade || a.index - b.index || (a.t < b.t ? -1 : 1))
const seen = new Set<string>()
const picked = candidates.filter(({ t }) => !seen.has(t) && seen.add(t)).slice(0, LIMIT)
const traditional = picked.map(({ t }) => t).join('')
const simplified = [...new Set(picked.map(({ s }) => s))].join('')
const date = new Date().toISOString().slice(0, 10)
const chunk = (text: string) =>
  (text.match(/.{1,50}/gu) ?? []).map((line) => `  '${line}',`).join('\n')

const output = `// 由 packages/evals/scripts/chinese-variant-table.ts 生成，请勿手改（${date}，Unihan ${variants.version}）。
// 来源：Unihan kTraditionalVariant / kSimplifiedVariant；常用范围取 kTGH 一级字（≤ 3500）的简体字，
// 按繁体字的 kGradeLevel（香港小学识字年级）与简体字的 kTGH 序号排序，取前 ${LIMIT} 个繁体字。
// 两张表都只含「仅繁体」或「仅简体」的字，简繁同形字不在表中。

/** 常用「仅繁体」字（${[...traditional].length} 个） */
export const TRADITIONAL_ONLY = [
${chunk(traditional)}
].join('')

/** 与上表对应的常用「仅简体」字（${[...simplified].length} 个） */
export const SIMPLIFIED_ONLY = [
${chunk(simplified)}
].join('')
`
writeFileSync(resolve(import.meta.dirname, '../src/chinese-variant-table.ts'), output)
console.log(`仅繁体 ${[...traditional].length} 个，仅简体 ${[...simplified].length} 个`)
