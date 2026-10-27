/**
 * Minimal PROCESS-LOCAL keyed async mutex (no external dependency).
 *
 * `withKeyLock(key, fn)` runs `fn` so that, for a given key, only one `fn` executes at a time
 * WITHIN THIS NODE.JS PROCESS. Calls with different keys run concurrently; calls with the same
 * key queue and run in arrival order. The chain entry is removed once idle (no leak).
 *
 * SCOPE (important): this serializes only same-process callers. Under PM2 cluster mode (this app
 * runs `instances: 2`) HTTP requests are spread across workers and the scheduler runs on one
 * worker, so this does NOT serialize a request on worker B against the scanner on worker 0, nor
 * two requests on different workers. It closes the same-worker window only. True cross-process
 * mutual exclusion needs a shared coordinator (DB unique key / lock row / Redis) — see the
 * permission-policy notes. Callers must therefore remain idempotent on their own.
 */
const chains = new Map();

function withKeyLock(key, fn) {
  const k = String(key);
  const prev = chains.get(k) || Promise.resolve();
  // Run fn after the previous holder settles (success OR failure — a rejection must not wedge the key).
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  chains.set(k, tail);
  // Clean up when this is still the tail (idle), so the map doesn't grow unbounded.
  tail.then(() => { if (chains.get(k) === tail) chains.delete(k); });
  return run;
}

module.exports = { withKeyLock };
