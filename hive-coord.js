// hive-coord.js — the Hive coordination layer (v0 prototype).
//
// The bet: AI coding agents work fast and BLIND — they collide because, unlike a human
// team, they have no way to coordinate BEFORE they edit. Merging (ICR) cleans up after a
// collision. This prevents the collision in the first place.
//
// The design is a real hive: NO central controller, no conductor, no extra agent. Order
// emerges from each agent following one local rule against a shared medium — exactly how
// bees coordinate via traces in the environment (stigmergy), and how millions of Ethernet
// devices share one wire with no master (carrier-sense / collision-detect / backoff).
//
// The shared medium is a CRDT map living IN the codebase doc (a Y.Map in Hivecode; a plain
// Map in tests). Each region of work (a file, or a unit) can hold one CLAIM:
//     { by: agentId, intent: string, at: time, ttl: ms }
//
// An agent's entire protocol — no coordinator anywhere:
//   1. SENSE   — read the shared map. Is my target region claimed and fresh?
//   2. FLOW    — if taken, move to open space (pick another free region). This is the
//                emergent load-balancing: agents spread across the codebase on their own.
//   3. CLAIM   — write my claim to the free region.
//   4. VERIFY  — re-read (collision-detect): if a concurrent claim beat mine, BACK OFF and
//                retry later. (Like Ethernet: listen, send, detect collision, back off.)
//   5. RELEASE — when done, delete my claim and (optionally) leave a "done" trace.
//
// EVAPORATION: claims carry a TTL. A crashed or stalled agent's claim simply expires, and
// the region frees itself — no central garbage collector, no deadlock. (The pheromone fades.)
//
// `shared` is any object with get(key)/set(key,val)/delete(key)/entries() — so the same
// code runs on a JS Map (tests) and a Yjs Y.Map (production). `now` is injectable so tests
// can drive a deterministic virtual clock.

export function makeCoordinator(shared, self, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : 5000
  const now = opts.now || (() => Date.now())
  const expired = (c) => !c || (now() - c.at) >= c.ttl

  // SENSE: the live, non-expired claim on a region (or null if open).
  const sense = (region) => { const c = shared.get(region); return expired(c) ? null : c }

  // Is this region open to ME? (free, expired, or already mine)
  const free = (region) => { const c = shared.get(region); return expired(c) || c.by === self }

  const claim = (region, intent) => { shared.set(region, { by: self, intent, at: now(), ttl }) }
  const release = (region) => { const c = shared.get(region); if (c && c.by === self) shared.delete(region) }

  // ACQUIRE one region: sense → claim → verify. Returns true iff I now hold it.
  // The verify step is the collision-detector: if a concurrent writer won the region,
  // I see their id on re-read and concede.
  const acquire = (region, intent) => {
    const c = shared.get(region)
    if (c && !expired(c) && c.by !== self) return false // sensed an owner → defer
    claim(region, intent)
    const after = shared.get(region)
    return !(after && after.by !== self) // verify: did my claim survive?
  }

  // FLOW to open space: try my preferred regions in order, take the first I can acquire.
  // This is what makes the swarm spread out with nobody assigning work.
  const acquireAny = (candidates, intent) => {
    for (const r of candidates) if (acquire(r, intent)) return r
    return null
  }

  // Everything currently claimed (live), as a snapshot — for awareness / a Control Room.
  const board = () => {
    const out = []
    for (const [region, c] of shared.entries()) if (!expired(c)) out.push({ region, ...c })
    return out
  }

  return { sense, free, claim, release, acquire, acquireAny, board }
}
