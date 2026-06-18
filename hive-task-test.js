// Proves directed work + the permission gate:
//   - Jeevan (human) tells Bot (an AI owned by Friend) to do something
//   - Bot sees a PENDING task but must not act
//   - Jeevan (not the owner) is BLOCKED from approving it
//   - Friend (the owner) approves -> Bot sees it ACCEPTED -> Bot completes it
//
//   node hive-task-test.js

import { spawn } from 'child_process'
import { startSync } from './sync.js'

const PORT = 1245
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'task-test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const opts = { relay: RELAY, room: ROOM, syncFiles: false, log: () => {} }
const jeevan = startSync({ ...opts, dir: '.tasktmp/j', name: 'Jeevan', kind: 'human' })
const friend = startSync({ ...opts, dir: '.tasktmp/f', name: 'Friend', kind: 'human' })
const bot = startSync({ ...opts, dir: '.tasktmp/b', name: 'Bot', kind: 'ai', owner: 'Friend' })
await sleep(1500) // connect + propagate the owners map

const botTasks = () => bot.myTasks()
const status = (id) => (bot.doc.getMap('tasks').get(id) || {}).status

console.log('# Jeevan tells Bot to work on something')
const id = jeevan.assign('Bot', 'refactor auth.js login')
await sleep(800)
assert('Bot sees the task', botTasks().some((t) => t.id === id))
assert('task is PENDING (Bot must not act yet)', status(id) === 'pending')

console.log('\n# Jeevan is NOT Bot\'s owner -> cannot approve')
const bad = jeevan.decide(id, true) // by Jeevan
await sleep(600)
assert('non-owner approval is rejected', !!bad.error)
assert('task is still pending', status(id) === 'pending')

console.log('\n# Friend (Bot\'s owner) approves -> Bot may act')
const good = friend.decide(id, true) // by Friend
await sleep(800)
assert('owner approval succeeds', good.ok === true)
assert('Bot now sees it ACCEPTED', status(id) === 'accepted')

console.log('\n# Bot does the work and completes it')
bot.complete(id, 'added validation to login')
await sleep(800)
assert('task is done', status(id) === 'done')

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
jeevan.stop(); friend.stop(); bot.stop(); relay.kill()
process.exit(failed === 0 ? 0 : 1)
