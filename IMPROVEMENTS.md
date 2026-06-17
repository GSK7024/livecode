# Improvements log (autonomous session)

Work done while you were at lunch. Every change verified before moving on.

## Done & verified

### Safety net
- **`test.js`** — automated test suite (18 tests, all passing). Covers: text
  diff, CRDT convergence, claim protocol, version check, lock/negotiation
  logic, deadlock-safe ordering, room isolation. Run any time: `node test.js`.
- **`core.js`** — shared pure logic (applyDiff, safeBump, lock helpers,
  lockOrder) so the same tested code is used everywhere instead of copies.

### Performance
- **Folder sync now skips unchanged files.** Before: it re-read every file's
  full contents every 400 ms. Now: it checks each file's modification time and
  only reads the ones that actually changed. On a big project this is the
  difference between heavy constant disk reads and almost nothing.
  Applied to both `folder.js` and the VS Code extension.
- Verified create / edit / delete still sync correctly after the change.

### Robustness
- **Deadlock-safe multi-file locking** (`acquireAll` in `agent-lock.js`):
  agents that need several files lock them in sorted order, so two agents can
  never deadlock waiting on each other. Unit-tested.
- `agent-lock.js` refactored to use the shared, tested `core.js` helpers.
- Live negotiation re-tested after refactor — still works.

### Housekeeping
- Extension repackaged with the optimizations → `extension/livecode-0.1.0.vsix`.
- Stopped tracking the `.vsix` build artifact in git.

## Roadmap (not done — needs your input or is bigger)

1. **Richer negotiation** — let a lock holder DENY or COUNTER a request
   ("wait, my change touches that too"), not just auto-hand-over. The request
   channel already carries the summary; this needs a policy for *when* to deny,
   which is really an AI judgment call → ties into #3.
2. **Live cursors + keystroke sync** in the extension (the Google-Docs feel).
   Bigger: bind to the editor buffer instead of the file on disk.
3. **Plug in real AI** — replace the stub edits in the agents with actual
   Claude calls so they truly reason. Needs an API key (yours), so I left it.
4. **Business plan** — tiers, pricing, what to charge for.

## How to check my work
```
node test.js          # 18 tests should pass
```
