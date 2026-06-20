// Hivecode access tokens — a tiny, dependency-free JWT (JWS) implementation used
// by the relay (verify) and the hive-token CLI (mint). No external libs: just
// Node's crypto, so there's no supply-chain surface for the thing that guards
// access. Supports HS256 (shared secret — self-host) and RS256 (public/private
// key — a hosted control plane signs, relays verify with the public key).
//
// Token shape (claims):
//   {
//     iss, sub,                 // issuer, principal id
//     name, kind,               // display name + 'human' | 'ai'
//     owner,                    // (agents) the human who may approve its tasks
//     scopes: [                 // what this principal may reach
//       { room: "room-id" | "acme/*" | "*", role: "admin|maintainer|writer|reader|agent",
//         paths: ["src/**", "!**/*.env"] }   // path globs are enforced in a later phase
//     ],
//     iat, exp,                 // issued-at, expiry (unix seconds)
//     jti                       // unique id, for revocation
//   }

import crypto from 'crypto'
import ignore from 'ignore'

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const enc = (obj) => b64url(JSON.stringify(obj))

// --- mint ---
// signWith: { secret } -> HS256, or { privateKey } -> RS256.
export function sign(payload, signWith) {
  const useRsa = !!signWith.privateKey
  const header = { alg: useRsa ? 'RS256' : 'HS256', typ: 'JWT' }
  const data = enc(header) + '.' + enc(payload)
  let sig
  if (useRsa) sig = crypto.sign('RSA-SHA256', Buffer.from(data), signWith.privateKey)
  else sig = crypto.createHmac('sha256', signWith.secret).update(data).digest()
  return data + '.' + b64url(sig)
}

// --- verify ---
// verifyWith: { secret } and/or { publicKey }. The token's header.alg selects
// which key is used. Returns { ok, payload } or { ok:false, error }.
export function verify(token, verifyWith = {}, now = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'no token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed token' }
  const [h, p, s] = parts
  let header, payload
  try { header = JSON.parse(b64urlToBuf(h).toString('utf8')); payload = JSON.parse(b64urlToBuf(p).toString('utf8')) }
  catch { return { ok: false, error: 'undecodable token' } }
  const data = h + '.' + p
  const sig = b64urlToBuf(s)

  if (header.alg === 'HS256') {
    if (!verifyWith.secret) return { ok: false, error: 'HS256 token but relay has no secret configured' }
    const expected = crypto.createHmac('sha256', verifyWith.secret).update(data).digest()
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return { ok: false, error: 'bad signature' }
  } else if (header.alg === 'RS256') {
    if (!verifyWith.publicKey) return { ok: false, error: 'RS256 token but relay has no public key configured' }
    let valid = false
    try { valid = crypto.verify('RSA-SHA256', Buffer.from(data), verifyWith.publicKey, sig) } catch { valid = false }
    if (!valid) return { ok: false, error: 'bad signature' }
  } else {
    return { ok: false, error: `unsupported alg: ${header.alg}` }
  }

  if (payload.exp != null && now >= payload.exp) return { ok: false, error: 'token expired' }
  if (payload.nbf != null && now < payload.nbf) return { ok: false, error: 'token not yet valid' }
  return { ok: true, payload }
}

// --- room naming for the per-file subdoc model (Phase 2) ---
// A project is a PARENT room (manifest + coordination) plus one room per file,
// named `<baseRoom>␁<path>`. Encoding the path in the room name lets the relay
// authorize per-path (Phase 3) and lets a client connect only to the files it
// may load. FILE_SEP is a control char that never appears in room ids or paths.
export const FILE_SEP = ''
export const fileRoom = (baseRoom, relPath) => baseRoom + FILE_SEP + relPath
export const baseRoomOf = (room) => { const i = room.indexOf(FILE_SEP); return i < 0 ? room : room.slice(0, i) }
export const pathOf = (room) => { const i = room.indexOf(FILE_SEP); return i < 0 ? null : room.slice(i + 1) }

// Does a scope's room pattern authorize this room? Supports exact, "*" (all),
// and a trailing "*" prefix wildcard (e.g. "acme/*" matches "acme/api").
export function roomMatches(pattern, room) {
  if (!pattern) return false
  if (pattern === '*' || pattern === room) return true
  if (pattern.endsWith('*')) return room.startsWith(pattern.slice(0, -1))
  return false
}

// Find the scope (and role) that authorizes `room`, or null.
export function scopeForRoom(payload, room) {
  const scopes = Array.isArray(payload && payload.scopes) ? payload.scopes : []
  return scopes.find((sc) => roomMatches(sc.room, room)) || null
}

// Phase 3: is a file path allowed by a scope's path globs? Gitignore-style globs
// (via the `ignore` lib): positive patterns grant subtrees, "!"-prefixed patterns
// deny. No globs (or none given) = the whole room is allowed (Phase-2 behavior).
//   pathAllowed(["src/**", "!**/*.env"], "src/app.js") -> true
//   pathAllowed(["src/**"],            "secrets/k.txt") -> false
export function pathAllowed(globs, relPath) {
  if (!Array.isArray(globs) || globs.length === 0) return true
  const pos = [], neg = []
  for (const g of globs) { if (typeof g !== 'string' || !g) continue; if (g[0] === '!') neg.push(g.slice(1)); else pos.push(g) }
  const matches = (pats) => pats.length > 0 && ignore().add(pats).ignores(relPath)
  const inAllow = pos.length === 0 ? true : matches(pos)
  return inAllow && !matches(neg)
}

// Read a token's payload WITHOUT verifying — for a client to inspect its OWN grant
// (e.g. which paths it may open) for UX. NEVER use for access decisions; the relay
// is the enforcer (it verifies the signature).
export function decodeUnsafe(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) }
  catch { return null }
}
