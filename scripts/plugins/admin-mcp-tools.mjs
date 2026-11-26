import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'

const CONFIG = '/admin-mcp/tsconfig.json'

function called(node, name) {
  return (
    node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  )
}

function builtinNames(source) {
  const names = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const { initializer } of statement.declarationList.declarations) {
      if (!called(initializer, 'defineAdminTool')) continue
      const [definition] = initializer.arguments
      const property =
        definition &&
        ts.isObjectLiteralExpression(definition) &&
        definition.properties.find(
          (field) => ts.isPropertyAssignment(field) && field.name.text === 'name',
        )
      if (!property || !ts.isStringLiteral(property.initializer))
        throw new Error(`${source.fileName}: defineAdminTool requires a literal name`)
      names.push(property.initializer.text)
    }
  }
  return names
}

function contributionNames(source, id) {
  const invalid = () =>
    new Error(
      `plugin ${id}: declare adminMcpTools directly as createServerOnlyFn(() => ({ 'tool.name': factory })) with literal keys`,
    )
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ((ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(({ name }) => name.text === 'adminMcpTools')) ||
        (ts.isNamespaceExport(statement.exportClause) &&
          statement.exportClause.name.text === 'adminMcpTools'))
    )
      throw invalid()
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue
    if (!ts.isVariableStatement(statement)) {
      if (statement.name?.text === 'adminMcpTools') throw invalid()
      continue
    }
    const declaration = statement.declarationList.declarations.find(
      ({ name }) => ts.isIdentifier(name) && name.text === 'adminMcpTools',
    )
    if (!declaration) continue
    const call = declaration.initializer
    if (
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      !called(call, 'createServerOnlyFn')
    )
      throw invalid()
    const [factory] = call.arguments
    if (!factory || !ts.isArrowFunction(factory)) throw invalid()
    let body = factory.body
    if (ts.isParenthesizedExpression(body)) body = body.expression
    if (!ts.isObjectLiteralExpression(body)) throw invalid()
    return body.properties.map((field) => {
      if (!ts.isPropertyAssignment(field) || !ts.isStringLiteral(field.name)) throw invalid()
      return field.name.text
    })
  }
  return []
}

/** 只解析源码字面量，生成阶段不加载 Web 模块、Vite 别名或运行时依赖。 */
export function adminMcpContributors(root, plugins) {
  const entries = plugins.filter(({ manifest }) => manifest.entries?.web)
  if (!entries.length) return new Set()
  const builtins = plugins.find(({ manifest }) => manifest.id === 'admin-mcp')
  const builtinDir = join(builtins?.dir ?? join(root, 'plugins/admin-mcp'), 'src/web/tools')
  const builtinFiles = existsSync(builtinDir)
    ? readdirSync(builtinDir)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .map((file) => join(builtinDir, file))
    : []
  const entryFiles = entries.map(({ dir, manifest }) => join(dir, manifest.entries.web))
  const paths = [...new Set([...builtinFiles, ...entryFiles])]
  const fs = createVirtualFileSystem({
    [CONFIG]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, allowJs: true },
      files: paths,
    }),
    ...Object.fromEntries(paths.map((file) => [file, readFileSync(file, 'utf8')])),
  })
  const api = new API({ cwd: '/admin-mcp', fs })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [CONFIG] })
    try {
      const { program } = snapshot.getProject(CONFIG)
      const owners = new Map()
      const contributors = new Set()
      const claim = (name, owner) => {
        if (owners.has(name))
          throw new Error(`Duplicate admin MCP tool ${name}: ${owner} and ${owners.get(name)}`)
        owners.set(name, owner)
      }
      for (const file of builtinFiles)
        for (const name of builtinNames(program.getSourceFile(file))) claim(name, 'built-in')

      for (const [index, { manifest }] of entries.entries()) {
        const { id } = manifest
        for (const name of contributionNames(program.getSourceFile(entryFiles[index]), id)) {
          claim(name, id)
          if (!name.startsWith(`${id}.`) || name.length <= id.length + 1)
            throw new Error(`plugin ${id}: admin MCP tool ${name} must start with ${id}.`)
          contributors.add(id)
        }
      }
      return contributors
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}
