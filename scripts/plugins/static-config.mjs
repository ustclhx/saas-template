// 从 git archive 生成副本时尚未安装依赖。这里只读取静态对象中的成员和源码位置，
// 不执行 template.config.ts 或插件清单（其中可能导入 Zod 配置 schema）。
const tokenPattern =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\w$-]+|[^\s]/g
const closing = { '{': '}', '[': ']', '(': ')' }

function staticKey(token) {
  if (token.startsWith('"')) return JSON.parse(token)
  if (token.startsWith("'")) return token.slice(1, -1).replace(/\\(['\\])/g, '$1')
  return token
}

function* tokens(source, from = 0) {
  const pattern = new RegExp(tokenPattern)
  pattern.lastIndex = from
  for (const match of source.matchAll(pattern)) {
    if (match[0].startsWith('//') || match[0].startsWith('/*')) continue
    yield { value: match[0], start: match.index, end: match.index + match[0].length }
  }
}

/** Direct members of an object or array literal, with source ranges for surgical edits. */
export function staticCollection(source, start = tokens(source).next().value?.start) {
  const opening = source[start]
  if (opening !== '{' && opening !== '[') throw new Error('预期静态对象或数组')
  const stack = [closing[opening]]
  const members = []
  let member = []
  for (const token of tokens(source, start + 1)) {
    if (stack.length === 1 && (token.value === ',' || token.value === stack[0])) {
      if (member.length) {
        const object = opening === '{'
        if (object && member[1]?.value !== ':') throw new Error('预期静态对象属性')
        members.push({
          key: object ? staticKey(member[0].value) : undefined,
          start: member[0].start,
          end: member.at(-1).end,
          valueStart: member[object ? 2 : 0].start,
          comma: token.value === ',' ? token.start : undefined,
        })
      }
      if (token.value !== ',') return { start, end: token.end, members }
      member = []
      continue
    }
    if (Object.hasOwn(closing, token.value)) stack.push(closing[token.value])
    else if (token.value === stack.at(-1)) stack.pop()
    member.push(token)
  }
  throw new Error('静态对象或数组未闭合')
}

export function configCall(source, functionName) {
  let previous
  let functionCall = false
  for (const token of tokens(source)) {
    if (token.value === '{' && functionCall) return staticCollection(source, token.start)
    functionCall = token.value === '(' && previous === functionName
    previous = token.value
  }
  throw new Error(`缺少 ${functionName}({ … }) 静态配置`)
}

/** Collect module-scope literal const declarations used to share manifest metadata. */
export function staticConstants(source) {
  const all = Array.from(tokens(source))
  const values = new Map()
  const stack = []
  for (const [index, token] of all.entries()) {
    const [name, equals, value] = all.slice(index + 1, index + 4)
    if (stack.length === 0 && token.value === 'const' && equals?.value === '=' && value) {
      const end = ['{', '['].includes(value.value)
        ? staticCollection(source, value.start).end
        : value.end
      values.set(name.value, source.slice(value.start, end))
    }
    if (Object.hasOwn(closing, token.value)) stack.push(closing[token.value])
    else if (token.value === stack.at(-1)) stack.pop()
  }
  return values
}

/** Parse the literal metadata of a plugin manifest independently of its schema. */
export function staticValue(source, constants = new Map(), resolving = []) {
  const values = Array.from(tokens(source), (token) => token.value)
  return JSON.parse(
    values
      .map((value, index) => {
        const next = values[index + 1]
        if (value === ',' && (next === '}' || next === ']')) return ''
        if (value.startsWith("'") || next === ':') return JSON.stringify(staticKey(value))
        if (constants.has(value)) {
          if (resolving.includes(value)) throw new Error(`静态清单常量有循环引用 ${value}`)
          return JSON.stringify(staticValue(constants.get(value), constants, [...resolving, value]))
        }
        return value
      })
      .join(' '),
  )
}
