// AUTO-GENERATED from lang-js.js + icr.js by build-icr-cjs.cjs — do not edit by hand.
// CommonJS bundle of the ICR merge engine for the (CommonJS, separately-packaged) extension.
const acorn = require('acorn')

const { javascript } = (function () {
// lang-js.js — the JavaScript language provider for ICR.
//
// ICR's merge engine (icr.js) is language-agnostic: it merges a list of keyed "units"
// and asks intent questions ("what names are declared / used / what's a function body").
// Everything that actually knows about a *language* — how to parse it, what a top-level
// declaration is, how to find references — lives behind a provider like this one.
//
// To add a language (Python, Go, Rust…), write another module exposing the same shape
// and register it with icr.js's registerLanguage(). This JS provider is just the first
// plugin; it happens to use `acorn` because acorn is a tiny pure-JS parser. A tree-sitter
// provider would implement the identical interface over tree-sitter grammars.


// Parse permissively: try module syntax, fall back to script (so plain snippets and
// ESM both work). Throws only when the code genuinely won't parse either way.
function parse(src) {
  try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }) }
  catch { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }) }
}

function parses(src) { try { parse(src); return true } catch { return false } }

// A stable key per top-level node — what lets us recognize "the same declaration"
// across two edits. Names where we have them; position as a last resort.
function keyOf(node, i) {
  let n = node
  if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
  if (n.type === 'ExportDefaultDeclaration') return 'export:default'
  if (n.type === 'FunctionDeclaration' && n.id) return 'fn:' + n.id.name
  if (n.type === 'ClassDeclaration' && n.id) return 'class:' + n.id.name
  if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].id && n.declarations[0].id.name)
    return 'var:' + n.declarations[0].id.name
  // Key imports by their SOURCE MODULE, so two agents adding imports from DIFFERENT
  // modules never collide, and two touching the SAME module are merged (specifier union).
  if (n.type === 'ImportDeclaration') return 'import:' + (n.source && n.source.value != null ? n.source.value : i)
  return 'stmt:' + i
}

// Top-level units: ordered { key, text, start, end } for each declaration/statement.
// start/end are byte offsets in `src` — used by the format-preserving splice so unchanged
// regions (and the whitespace/comments between units) survive a merge verbatim.
function units(src) {
  const ast = parse(src)
  return ast.body.map((node, i) => ({ key: keyOf(node, i), text: src.slice(node.start, node.end), start: node.start, end: node.end }))
}

// Bare declared name (foo, Bar, VERSION) of a node, or null for anonymous statements.
function bareName(node) {
  let n = node
  if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
  if (n.type === 'FunctionDeclaration' && n.id) return n.id.name
  if (n.type === 'ClassDeclaration' && n.id) return n.id.name
  if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].id && n.declarations[0].id.name) return n.declarations[0].id.name
  return null
}

function declaredNames(src) {
  const s = new Set()
  for (const node of parse(src).body) {
    const nm = bareName(node); if (nm) s.add(nm)
    // Import locals count as declared names too — so if an import is ever dropped and its
    // binding is still used, the dangling-reference check catches it (safety net for the
    // import merge). Keeps the never-emit-broken-code guarantee honest for imports.
    if (node.type === 'ImportDeclaration') for (const sp of node.specifiers) s.add(sp.local.name)
  }
  return s
}

// --- import-aware merging -------------------------------------------------------
// Parse a single import statement into its parts, or null if it isn't one.
function parseImport(src) {
  let n
  try { n = parse(src).body[0] } catch { return null }
  if (!n || n.type !== 'ImportDeclaration') return null
  let def = null, ns = null
  const named = []
  for (const sp of n.specifiers) {
    if (sp.type === 'ImportDefaultSpecifier') def = sp.local.name
    else if (sp.type === 'ImportNamespaceSpecifier') ns = sp.local.name
    else named.push({ imported: sp.imported.name != null ? sp.imported.name : sp.imported.value, local: sp.local.name })
  }
  return { source: n.source.value, def, ns, named }
}
function renderImport({ source, def, ns, named }) {
  const parts = []
  if (def) parts.push(def)
  if (ns) parts.push('* as ' + ns)
  if (named.length) parts.push('{ ' + named.map((s) => s.imported === s.local ? s.local : s.imported + ' as ' + s.local).join(', ') + ' }')
  if (!parts.length) return "import '" + source + "'"
  return 'import ' + parts.join(', ') + " from '" + source + "'"
}
// Both sides changed an import from the SAME module → union their specifiers into one
// statement (the common "both agents added an import" case). Returns null — meaning
// "let the normal conflict path handle it" — for anything we can't safely combine
// (different modules, clashing defaults/namespaces, namespace-mixed-with-named).
function mergeUnit(baseText, aText, bText) {
  const a = parseImport(aText), b = parseImport(bText)
  if (!a || !b || a.source !== b.source) return null
  let def
  if (a.def && b.def) { if (a.def !== b.def) return null; def = a.def } else def = a.def || b.def
  let ns
  if (a.ns && b.ns) { if (a.ns !== b.ns) return null; ns = a.ns } else ns = a.ns || b.ns
  if (ns && (a.named.length || b.named.length)) return null // `* as X` can't share a statement with named imports
  const seen = new Set(), named = []
  for (const s of [...a.named, ...b.named]) { const k = s.imported + '|' + s.local; if (!seen.has(k)) { seen.add(k); named.push(s) } }
  return renderImport({ source: a.source, def, ns, named })
}

// The BODY of a top-level declaration, by name, with the name itself excluded — so two
// declarations that differ only in their name compare equal (that's how we spot a rename).
function declBody(src, name) {
  for (const node of parse(src).body) {
    if (bareName(node) !== name) continue
    let n = node
    if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.body)
      return src.slice(n.body.start, n.body.end)
    if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].init) {
      const init = n.declarations[0].init
      return src.slice(init.start, init.end)
    }
    return null
  }
  return null
}

// Rewrite every reference to `oldName` as `newName` (skipping property/key positions,
// which aren't references to the declaration). Edits back-to-front to keep offsets valid.
function renameRefs(src, oldName, newName) {
  const spots = []
  walk(parse(src), (node, parent, key) => {
    if (node.type !== 'Identifier' || node.name !== oldName) return
    if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return
    if (parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return
    spots.push([node.start, node.end])
  })
  spots.sort((a, b) => b[0] - a[0])
  let out = src
  for (const [s, e] of spots) out = out.slice(0, s) + newName + out.slice(e)
  return out
}

// Every identifier USED anywhere (skips obj.prop names and non-computed object keys).
// Approximate — good enough for the intent check; the real version is scope-aware.
function usedIdentifiers(src) {
  const used = new Set()
  walk(parse(src), (node, parent, key) => {
    if (node.type !== 'Identifier') return
    if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return
    if (parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return
    used.add(node.name)
  })
  return used
}

function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent, key)
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) { for (const c of v) walk(c, visit, node, k) }
    else if (v && typeof v.type === 'string') walk(v, visit, node, k)
  }
}

// --- scope-aware reference analysis ---------------------------------------------
// The names REFERENCED in `src` that resolve to NOTHING in the file's own scopes —
// i.e. free/global names, including any use of a top-level declaration. This is the
// scope-aware upgrade of usedIdentifiers: a use of `x` that resolves to a LOCAL binding
// (a param, a `const x` in the same function, a catch var, a loop var…) is NOT counted,
// because it isn't a reference to a top-level declaration. That lets ICR tell a deleted
// top-level `helper` apart from an unrelated local `helper` that merely shares its name.
//
// Honest scope coverage: functions (declaration/expression/arrow), blocks, catch
// clauses, for/for-in/for-of loop bindings, params with simple destructuring, imports,
// var-hoisting to the function scope, and let/const/class/function block binding.
// Approximations (rare, and they only ever make the dangling check MORE cautious):
// default-value expressions in patterns and `with`/eval are not modeled.
// Walk the AST and call emit(identifierNode) for every reference that resolves to NO
// local binding (free / would resolve to module or global scope). Both the dangling-ref
// check and scope-aware renaming are built on this single traversal.
function walkFreeRefs(src, emit) { resolveScopes(parse(src), null, emit) }

function referencedFreeNames(src) {
  const free = new Set()
  walkFreeRefs(src, (node) => free.add(node.name))
  return free
}

// Rename ONLY the free references to oldName (those that resolve to the top-level/global
// binding) — never a local variable that merely shares the name. Edits back-to-front.
function renameFreeRefs(src, oldName, newName) {
  const spots = []
  walkFreeRefs(src, (node) => { if (node.name === oldName) spots.push([node.start, node.end]) })
  spots.sort((a, b) => b[0] - a[0])
  let out = src
  for (const [s, e] of spots) out = out.slice(0, s) + newName + out.slice(e)
  return out
}

const CHILD_SKIP = new Set(['type', 'start', 'end', 'loc', 'range'])
function eachChild(node, fn) {
  for (const k of Object.keys(node)) {
    if (CHILD_SKIP.has(k)) continue
    const v = node[k]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') fn(c) }
    else if (v && typeof v.type === 'string') fn(v)
  }
}

// Names introduced by a binding target (handles identifiers + simple destructuring).
function bindingNames(node, out) {
  if (!node) return
  switch (node.type) {
    case 'Identifier': out.add(node.name); break
    case 'ObjectPattern': for (const p of node.properties) bindingNames(p.type === 'RestElement' ? p.argument : p.value, out); break
    case 'ArrayPattern': for (const el of node.elements) if (el) bindingNames(el, out); break
    case 'AssignmentPattern': bindingNames(node.left, out); break
    case 'RestElement': bindingNames(node.argument, out); break
  }
}

// A binding target's NAMES are bindings, but its default values (`a = expr`) and computed
// destructuring keys (`{ [k]: v }`) are REFERENCES that must be resolved against the scope.
// Without this, a name used only in a default value would be missed by the dangling check.
function resolveBindingDefaults(node, scope, emit) {
  if (!node) return
  switch (node.type) {
    case 'AssignmentPattern': resolveBindingDefaults(node.left, scope, emit); resolveScopes(node.right, scope, emit); break
    case 'ObjectPattern': for (const p of node.properties) {
      if (p.type === 'RestElement') { resolveBindingDefaults(p.argument, scope, emit); break }
      if (p.computed) resolveScopes(p.key, scope, emit)
      resolveBindingDefaults(p.value, scope, emit)
    } break
    case 'ArrayPattern': for (const el of node.elements) if (el) resolveBindingDefaults(el, scope, emit); break
    case 'RestElement': resolveBindingDefaults(node.argument, scope, emit); break
    // Identifier: a pure binding — nothing to resolve.
  }
}

const makeScope = (parent, fnScope) => { const s = { vars: new Set(), parent }; s.fnScope = fnScope || s; return s }
const resolves = (scope, name) => { for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return true; return false }

// Hoist var declarations + function declarations into the function scope (deep, but not
// crossing into nested functions, which own their own var scope).
function hoistFunctionScope(nodes, scope) { for (const n of nodes) collectHoisted(n, scope) }
function collectHoisted(node, scope) {
  if (!node || typeof node.type !== 'string') return
  if (node.type === 'FunctionDeclaration') { if (node.id) scope.fnScope.vars.add(node.id.name); return }
  if (/Function(Expression)?$|ArrowFunctionExpression/.test(node.type)) return // nested function: stop
  if (node.type === 'VariableDeclaration' && node.kind === 'var')
    for (const d of node.declarations) bindingNames(d.id, scope.fnScope.vars)
  eachChild(node, (c) => collectHoisted(c, scope))
}
// Bind let/const/class/function/import names declared directly in a block/program.
function hoistBlock(nodes, scope) {
  for (const n of nodes) {
    if (n.type === 'VariableDeclaration' && (n.kind === 'let' || n.kind === 'const'))
      for (const d of n.declarations) bindingNames(d.id, scope.vars)
    else if (n.type === 'ClassDeclaration' && n.id) scope.vars.add(n.id.name)
    else if (n.type === 'FunctionDeclaration' && n.id) scope.vars.add(n.id.name)
    else if (n.type === 'ImportDeclaration') for (const sp of n.specifiers) scope.vars.add(sp.local.name)
  }
}

function resolveScopes(node, scope, emit) {
  if (!node || typeof node.type !== 'string') return
  switch (node.type) {
    case 'Program': {
      const s = makeScope(null, null)
      hoistFunctionScope(node.body, s); hoistBlock(node.body, s)
      for (const c of node.body) resolveScopes(c, s, emit)
      return
    }
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
      const s = makeScope(scope, null)
      for (const p of node.params) bindingNames(p, s.vars)
      for (const p of node.params) resolveBindingDefaults(p, s, emit) // default values are references
      if (node.id && node.type === 'FunctionExpression') s.vars.add(node.id.name) // named fn expr
      if (node.body.type === 'BlockStatement') {
        hoistFunctionScope(node.body.body, s); hoistBlock(node.body.body, s)
        for (const c of node.body.body) resolveScopes(c, s, emit)
      } else resolveScopes(node.body, s, emit) // arrow with expression body
      return
    }
    case 'BlockStatement': {
      const s = makeScope(scope, scope.fnScope); hoistBlock(node.body, s)
      for (const c of node.body) resolveScopes(c, s, emit)
      return
    }
    case 'CatchClause': {
      const s = makeScope(scope, scope.fnScope)
      if (node.param) bindingNames(node.param, s.vars)
      resolveScopes(node.body, s, emit)
      return
    }
    case 'ForStatement': {
      const s = makeScope(scope, scope.fnScope)
      if (node.init && node.init.type === 'VariableDeclaration') hoistBlock([node.init], s)
      for (const k of ['init', 'test', 'update', 'body']) if (node[k]) resolveScopes(node[k], s, emit)
      return
    }
    case 'ForInStatement': case 'ForOfStatement': {
      const s = makeScope(scope, scope.fnScope)
      if (node.left.type === 'VariableDeclaration') hoistBlock([node.left], s)
      else resolveScopes(node.left, s, emit)
      resolveScopes(node.right, s, emit); resolveScopes(node.body, s, emit)
      return
    }
    case 'VariableDeclarator': { resolveBindingDefaults(node.id, scope, emit); if (node.init) resolveScopes(node.init, scope, emit); return } // id is a binding (defaults are refs)
    case 'Identifier': { if (!resolves(scope, node.name)) emit(node); return }
    case 'MemberExpression': { resolveScopes(node.object, scope, emit); if (node.computed) resolveScopes(node.property, scope, emit); return }
    case 'Property': { if (node.computed) resolveScopes(node.key, scope, emit); resolveScopes(node.value, scope, emit); return }
    case 'PropertyDefinition': case 'MethodDefinition': { if (node.computed) resolveScopes(node.key, scope, emit); if (node.value) resolveScopes(node.value, scope, emit); return }
    case 'LabeledStatement': { resolveScopes(node.body, scope, emit); return }
    case 'BreakStatement': case 'ContinueStatement': return // labels aren't value references
    case 'ExportSpecifier': { resolveScopes(node.local, scope, emit); return }
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return // binding positions
    default: eachChild(node, (c) => resolveScopes(c, scope, emit))
  }
}

// A stable key for a class member, so two agents editing DIFFERENT methods of the same
// class merge, while editing the SAME method conflicts.
function memberKey(m, i) {
  const kind = m.type === 'MethodDefinition' ? (m.kind === 'constructor' ? 'ctor' : 'method') : 'field'
  if (m.key && m.key.type === 'Identifier' && !m.computed)
    return kind + ':' + (m.static ? 'static.' : '') + m.key.name
  return 'member:' + i
}

// For finer-grained merging: split a single declaration into its signature text + keyed
// inner units, plus how to reassemble them. Handles FUNCTIONS (body statements, keyed
// like top-level decls) and CLASSES (members, keyed by method/field name). Returns null
// for anything else (the engine then treats the declaration as indivisible). Tolerates
// fragments that don't parse standalone (e.g. a bare `return`).
const MEMBER_WRAP = 'class __ICR__{'
// A class member (method) doesn't parse standalone — wrap it in a throwaway class so we
// can recurse INTO a method body that both agents edited. Offsets are mapped back to src.
function splitMember(src) {
  let ast
  try { ast = parse(MEMBER_WRAP + src + '}') } catch { return null }
  const cls = ast.body[0]
  if (!cls || cls.type !== 'ClassDeclaration' || !cls.body.body.length) return null
  const m = cls.body.body[0]
  if (!m || m.type !== 'MethodDefinition' || !m.value || !m.value.body || m.value.body.type !== 'BlockStatement') return null
  const off = MEMBER_WRAP.length, body = m.value.body
  const sig = src.slice(0, body.start - off)
  const units = body.body.map((s, i) => ({ key: keyOf(s, i), text: src.slice(s.start - off, s.end - off) }))
  return { sig, units, open: '{\n  ', join: '\n  ', close: '\n}' }
}

function splitUnit(src) {
  let ast
  try { ast = parse(src) } catch { return splitMember(src) } // maybe a class-member fragment
  let n = ast.body[0]
  if (!n) return null
  if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
  if (n.type === 'FunctionDeclaration' && n.body) {
    const sig = src.slice(n.start, n.body.start)
    const units = n.body.body.map((s, i) => ({ key: keyOf(s, i), text: src.slice(s.start, s.end) }))
    return { sig, units, open: '{\n  ', join: '\n  ', close: '\n}' }
  }
  if (n.type === 'ClassDeclaration' && n.body) {
    const sig = src.slice(n.start, n.body.start)
    const units = n.body.body.map((m, i) => ({ key: memberKey(m, i), text: src.slice(m.start, m.end) }))
    return { sig, units, open: '{\n  ', join: '\n\n  ', close: '\n}' }
  }
  // `const x = { ... }` / `const x = () => { ... }` / `const x = function () { ... }`
  if (n.type === 'VariableDeclaration' && n.declarations.length === 1 && n.declarations[0].init) {
    const init = n.declarations[0].init
    if (init.type === 'ObjectExpression') {
      const sig = src.slice(n.start, init.start)
      const units = init.properties.map((p, i) => ({ key: propKey(p, i), text: src.slice(p.start, p.end) }))
      return { sig, units, open: '{\n  ', join: ',\n  ', close: '\n}' }
    }
    if ((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && init.body && init.body.type === 'BlockStatement') {
      const sig = src.slice(n.start, init.body.start)
      const units = init.body.body.map((s, i) => ({ key: keyOf(s, i), text: src.slice(s.start, s.end) }))
      return { sig, units, open: '{\n  ', join: '\n  ', close: '\n}' }
    }
  }
  return null
}

// Stable key for an object-literal property, so two agents adding DIFFERENT keys union.
function propKey(p, i) {
  if (p.type === 'SpreadElement') return 'spread:' + i
  if (p.key && p.key.type === 'Identifier' && !p.computed) return 'prop:' + p.key.name
  if (p.key && p.key.type === 'Literal') return 'prop:' + String(p.key.value)
  return 'prop:' + i
}

// Does `src` parse either as top-level code OR as a class member? (The inner-merge result
// for a method is a fragment that's only valid inside a class — this lets us validate it.)
function parsesUnit(src) {
  if (parses(src)) return true
  try { parse(MEMBER_WRAP + src + '}'); return true } catch { return false }
}

// The provider contract every ICR language module implements.
const javascript = {
  id: 'javascript',
  exts: ['.js', '.mjs', '.cjs'],
  parses,
  units,
  declaredNames,
  usedIdentifiers,      // approximate (kept for reference)
  referencedFreeNames,  // scope-aware — what the engine prefers for the dangling check
  declBody,
  renameRefs,           // rewrites every matching identifier (kept for reference)
  renameFreeRefs,       // scope-aware — only rewrites references that resolve to the binding
  splitUnit,            // finer granularity: split a function/class/method into keyed inner units
  parsesUnit,           // validity oracle that also accepts a class-member fragment
  mergeUnit,            // language-specific same-key merge (import specifier union)
}

  return { javascript }
})()

const ICR = (function (javascript) {
// ICR — Intent-aware Code Replication (v1 proof-of-concept).
//
// The first real step from Hivecode-the-tool toward a FOUNDATIONAL primitive:
// merge code by STRUCTURE and INTENT, not characters, with a hard guarantee — never
// emit code more broken than its inputs.
//
// Why this matters: CRDTs (Yjs) merge characters. They will happily fuse two edits
// into syntactically-valid garbage, because they have no idea what code MEANS. ICR
// parses the code, merges at the level of declarations (functions / classes / vars),
// descends INTO a declaration both sides touched (so disjoint edits inside one function
// still merge), detects when two authors changed the SAME thing (a real conflict), and
// validates that the merged result still parses — falling back safely if it wouldn't.
//
// On top of structure it adds an INTENT layer:
//   • RENAME DETECTION — a declaration gone from base whose identical-bodied twin appears
//     under a new name is recognized as a rename; stale call sites are rewritten so the
//     other agent's fresh calls keep working. Nothing else does this.
//   • DANGLING REFERENCE — a declaration removed/renamed but still referenced is flagged
//     as a semantic conflict even though the code parses. CRDTs/git/plain merge miss it.
//
// LANGUAGE-AGNOSTIC BY DESIGN: this file is the engine. Everything that knows about a
// specific language (how to parse, what a declaration is, how to find references) lives
// behind a provider (see lang-js.js). Adding Python/Go/Rust = writing another provider
// and registerLanguage()-ing it; the merge logic below never changes. JavaScript via
// `acorn` is simply the first provider. The production path swaps in tree-sitter
// providers for every language behind this same interface.


// --- language registry ----------------------------------------------------------
const LANGUAGES = [javascript]

// Register an additional language provider. Must expose the provider contract:
// { id, exts:[...], parses, units, declaredNames, usedIdentifiers, declBody,
//   renameRefs, fnParts }. Newest wins on extension clashes.
function registerLanguage(provider) { LANGUAGES.unshift(provider) }

function extname(p) { const m = /\.[^.\/\\]+$/.exec(p || ''); return m ? m[0].toLowerCase() : '' }

// The provider for a filename, or null if no registered language claims its extension.
function languageFor(filename) {
  const e = extname(filename)
  return LANGUAGES.find((l) => l.exts.includes(e)) || null
}

// Can ICR merge this file structurally? (Callers gate on this before trying.)
function supports(filename) { return languageFor(filename) != null }

// --- generic merge primitives (language-independent: operate on {key,text}) -----
const mapOf = (us) => new Map(us.map((u) => [u.key, u.text]))
function dedupeOrder(keys) { const seen = new Set(), out = []; for (const k of keys) if (!seen.has(k)) { seen.add(k); out.push(k) } return out }

// For a given unit, choose which version survives: whoever CHANGED it wins; if neither
// changed it, keep the base.
function pick(k, B, A, Bb) {
  const base = B.has(k) ? B.get(k) : null
  const a = A.has(k) ? A.get(k) : null
  const b = Bb.has(k) ? Bb.get(k) : null
  if (a != null && a !== base) return a
  if (b != null && b !== base) return b
  return base != null ? base : (a != null ? a : b)
}

// Core 3-way merge over a KEYED list of units (works at file level AND, recursively,
// inside a single declaration). Returns { conflicts:[...], parts:[...text] }.
// When both sides change the SAME key into different things, it first tries to descend
// INTO that unit (finer granularity) — only a clash it can't resolve becomes a conflict.
function mergeKeyed(lang, baseU, aU, bU) {
  const B = mapOf(baseU), A = mapOf(aU), Bb = mapOf(bU)
  const keys = dedupeOrder([...baseU.map((u) => u.key), ...aU.map((u) => u.key), ...bU.map((u) => u.key)])

  const conflicts = [], resolved = new Map()
  for (const k of keys) {
    const bs = B.has(k) ? B.get(k) : null
    const as_ = A.has(k) ? A.get(k) : null
    const bbs = Bb.has(k) ? Bb.get(k) : null
    const changedA = as_ !== bs, changedB = bbs !== bs
    if (changedA && changedB && as_ !== bbs) {
      // Both touched the same unit, differently. Try finer-grained inner merge first.
      if (bs != null && as_ != null && bbs != null) {
        const inner = tryInnerMerge(lang, bs, as_, bbs)
        if (inner != null) { resolved.set(k, inner); continue }
      }
      conflicts.push(k)
    }
  }
  if (conflicts.length) return { conflicts, parts: [] }

  // No unresolved clashes → decide which keys survive, honoring one-sided deletions.
  const survives = new Set()
  for (const k of keys) {
    const inBase = B.has(k), inA = A.has(k), inB2 = Bb.has(k)
    if (inBase && (!inA || !inB2)) {
      const deletedByA = !inA, deletedByB = !inB2
      const otherUnchangedFromBase =
        (deletedByA && (!inB2 || Bb.get(k) === B.get(k))) ||
        (deletedByB && (!inA || A.get(k) === B.get(k)))
      if (otherUnchangedFromBase) continue // accept the deletion
    }
    survives.add(k)
  }

  // CONVERGENCE: the output order must be IDENTICAL no matter which side is `a` vs `b`,
  // or two peers compute different text and never settle (then re-merging the divergence
  // corrupts the file). So: surviving base units keep their base order; units added by a
  // side are appended in a canonical (sorted) order — deterministic and symmetric.
  const baseOrder = dedupeOrder(baseU.map((u) => u.key))
  const baseSet = new Set(baseOrder)
  const final = []
  for (const k of baseOrder) if (survives.has(k)) final.push(k)
  for (const k of [...survives].filter((k) => !baseSet.has(k)).sort()) final.push(k)

  // Assemble, recording PROVENANCE per surviving unit: who authored the version we kept
  // ('a' / 'b' changed it, 'both' if we merged inside it, 'base' if unchanged).
  const parts = [], provenance = [], order = [], textByKey = new Map()
  for (const k of final) {
    let text, from
    if (resolved.has(k)) { text = resolved.get(k); from = 'both' }
    else {
      text = pick(k, B, A, Bb)
      const bs = B.has(k) ? B.get(k) : null, as_ = A.has(k) ? A.get(k) : null, bbs = Bb.has(k) ? Bb.get(k) : null
      from = (as_ != null && as_ !== bs) ? 'a' : (bbs != null && bbs !== bs) ? 'b' : 'base'
    }
    if (text != null) { parts.push(text); provenance.push({ key: k, from }); order.push(k); textByKey.set(k, text) }
  }
  return { conflicts: [], parts, provenance, order, textByKey }
}

// FINER GRANULARITY: both sides edited the same function OR class. If the signature
// matches and they edited DIFFERENT inner units (statements / class members), merge those
// recursively rather than declaring the whole declaration a conflict. Returns merged
// text, or null meaning "couldn't safely merge inside — treat as a real conflict."
function tryInnerMerge(lang, baseText, aText, bText) {
  // Language-specific same-key merges first (e.g. unioning import specifiers).
  if (lang.mergeUnit) {
    const t = lang.mergeUnit(baseText, aText, bText)
    if (t != null && lang.parses(t)) return t
  }
  if (!lang.splitUnit) return null
  const pb = lang.splitUnit(baseText), pa = lang.splitUnit(aText), pbb = lang.splitUnit(bText)
  if (!pb || !pa || !pbb) return null
  if (pa.sig.trim() !== pbb.sig.trim()) return null // signature itself changed → real conflict
  const m = mergeKeyed(lang, pb.units, pa.units, pbb.units)
  if (m.conflicts.length) return null
  const text = pa.sig + pa.open + m.parts.join(pa.join) + pa.close
  const valid = lang.parsesUnit || lang.parses // accept class-member fragments when supported
  return valid(text) ? text : null
}

// FORMAT-PRESERVING assembly: rebuild the merged file by splicing the merged units back
// into the BASE text at their original byte ranges. Unchanged units — and all the
// whitespace/comments BETWEEN units — survive verbatim; only changed units carry the
// editing side's bytes, and genuinely new units are appended. This is what stops ICR from
// reformatting code it merges. Deterministic and symmetric, so peers converge.
function spliceUnits(baseText, baseUnits, order, textByKey) {
  const baseKeySet = new Set(baseUnits.map((u) => u.key))
  const surviving = new Set(order.filter((k) => baseKeySet.has(k)))
  const emitted = new Set()
  let out = '', pos = 0
  for (const u of baseUnits) {
    out += baseText.slice(pos, u.start) // gap before this unit (comments/blank lines), verbatim
    if (surviving.has(u.key) && !emitted.has(u.key)) { out += textByKey.get(u.key); emitted.add(u.key) }
    pos = u.end
  }
  const added = order.filter((k) => !baseKeySet.has(k))
  if (added.length) {
    const head = out.replace(/\s*$/, '')
    out = (head ? head + '\n\n' : '') + added.map((k) => textByKey.get(k)).join('\n\n') + '\n'
  } else {
    out += baseText.slice(pos) // trailing whitespace (final newline) verbatim
  }
  return out.replace(/^\n+/, '') // drop orphan leading blank lines left by a deleted first unit
}

// --- public API -----------------------------------------------------------------

// Does this source parse under the given (or default JS) language?
function parses(src, lang = javascript) { return lang.parses(src) }

// 3-way STRUCTURAL + INTENT merge of `a` and `b` against common ancestor `base`.
// opts: { lang } a provider, or { filename } to pick one by extension (defaults to JS).
// Returns { status, text, conflicts, renames? }:
//   'auto'              — clean merge; `text` is valid, parseable code.
//   'semantic-conflict' — same declaration changed both sides, or a dangling reference;
//                         `conflicts` names them (e.g. ['fn:login'] or ['ref:helper']).
//   'fallback'          — couldn't merge safely (unparseable input, or the merge wouldn't
//                         parse, or unsupported language); caller keeps both. Never broken.
function structuralMerge(base, a, b, opts = {}) {
  const lang = opts.lang || (opts.filename ? languageFor(opts.filename) : javascript) || javascript

  if (!lang.parses(base) || !lang.parses(a) || !lang.parses(b))
    return { status: 'fallback', text: null, conflicts: [], reason: 'unparseable input' }

  // FIXED-POINT fast path: once two peers agree on a text T, re-merging must return T
  // unchanged. This is what makes the live sync settle. Both agree ⇒ nothing to check.
  if (a === b) return { status: 'auto', text: a, conflicts: [], renames: [], provenance: [] }

  const authors = opts.authors || {}
  const attribute = (prov) => (prov || []).map((p) => ({ unit: p.key, author: authors[p.from] || p.from }))

  // Determine the structurally-merged text + provenance. A one-sided change takes that
  // side verbatim (format perfectly preserved); otherwise do the keyed 3-way merge and
  // splice it back into base. Either way the INTENT layer below still runs, so a deletion
  // that leaves a dangling reference is caught even when only one side changed.
  let text, provenance
  if (a === base) { text = b; provenance = [] }
  else if (b === base) { text = a; provenance = [] }
  else {
    const baseUnits = lang.units(base)
    const merge = mergeKeyed(lang, baseUnits, lang.units(a), lang.units(b))
    if (merge.conflicts.length) return { status: 'semantic-conflict', text: null, conflicts: merge.conflicts }
    // Prefer the format-preserving splice (units carry byte ranges); fall back to a plain
    // join for languages whose units don't expose ranges.
    const canSplice = baseUnits.every((u) => typeof u.start === 'number')
    text = canSplice ? spliceUnits(base, baseUnits, merge.order, merge.textByKey) : merge.parts.join('\n\n') + '\n'
    provenance = merge.provenance
  }

  // THE GUARANTEE: the merged result must parse, or we refuse it.
  if (!lang.parses(text)) return { status: 'fallback', text: null, conflicts: [], reason: 'merge would not parse' }

  // RENAME DETECTION (intent): a declaration gone from base whose identical-bodied twin
  // appears under a new name is a rename — rewrite stale call sites to the new name.
  let merged = text
  const baseNames = lang.declaredNames(base)
  let mergedNames = lang.declaredNames(merged)
  let removed = [...baseNames].filter((n) => !mergedNames.has(n))
  const renames = []
  const rename = lang.renameFreeRefs || lang.renameRefs // prefer scope-aware rewriting
  if (removed.length && lang.declBody && rename) {
    const added = [...mergedNames].filter((n) => !baseNames.has(n))
    const claimed = new Set()
    for (const oldName of removed) {
      const oldBody = lang.declBody(base, oldName)
      if (oldBody == null) continue
      const match = added.find((n) => !claimed.has(n) && lang.declBody(merged, n) === oldBody)
      if (match) { renames.push([oldName, match]); claimed.add(match) }
    }
    let rewritten = merged
    // Rewrite only references that resolve to the renamed binding (scope-aware) — a local
    // variable that merely shares the old name is left untouched.
    for (const [oldName, newName] of renames) rewritten = rename(rewritten, oldName, newName)
    // only accept the rewrite if it still parses — never trade a parse error for intent.
    if (renames.length && lang.parses(rewritten)) { merged = rewritten; mergedNames = lang.declaredNames(merged) }
  }

  // DANGLING REFERENCE (intent): a declaration removed (and NOT explained by a rename)
  // but still referenced is a semantic conflict even though the code parses cleanly.
  // Uses the SCOPE-AWARE reference set when the language provides one (so a local binding
  // that merely shares the deleted name is correctly NOT treated as a reference to it),
  // falling back to the approximate identifier set otherwise.
  removed = [...baseNames].filter((n) => !mergedNames.has(n))
  const refs = lang.referencedFreeNames ? lang.referencedFreeNames(merged)
    : lang.usedIdentifiers ? lang.usedIdentifiers(merged) : null
  if (removed.length && refs) {
    const dangling = removed.filter((n) => refs.has(n))
    if (dangling.length)
      return { status: 'semantic-conflict', text: null, conflicts: dangling.map((n) => 'ref:' + n), reason: 'dangling reference: a declaration was removed/renamed but is still used' }
  }
  // PROVENANCE: attribute each surviving unit to the author whose version we kept. With
  // opts.authors = { a, b, base } the labels are real names; otherwise they're 'a'/'b'/etc.
  return {
    status: 'auto', text: merged, conflicts: [],
    renames: renames.map(([o, n]) => o + '->' + n),
    provenance: attribute(provenance),
  }
}

  return { structuralMerge, supports, parses, registerLanguage, languageFor }
})(javascript)

module.exports = ICR
