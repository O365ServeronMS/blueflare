/** Calendar day (YYYY-MM-DD) in UTC: the unit OpenRouter resets its daily limits in. */
export const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
/** Next 00:00 UTC strictly after `ts`. */
export const nextUtcMidnight = (ts) => Math.floor(ts / 86400000) * 86400000 + 86400000;

/**
 * Persistent view of the per-day limits per API key + model.
 *
 *  - RPD: requests counted per UTC day (the day OpenRouter resets its limits on). A request counts the
 *    moment it is started and stays counted when it fails or times out: the provider may have
 *    charged it, and being wrong in that direction only costs a few requests.
 *  - RPM: spacing from the persisted `lastRequestAt`, so a restart does not burst.
 *  - TPM: sliding 60s window of real prompt tokens (estimated until the response reports them).
 *
 * The in-memory map answers `availability` synchronously; every change is written through
 * `store.save` in order. A store failure is logged and the ledger keeps working from memory.
 * Keys are identified by a non-reversible fingerprint only.
 */

export const TPM_WINDOW_MS = 60000;
const RPM_MARGIN_MS = 250;

const clone = (row) => ({ ...row, recent: row.recent.map((pair) => [...pair]) });

/** Same contract as the PostgreSQL store (aiQuotaStore.js), for tests and for running without a database. */
export function createMemoryQuotaStore() {
  const rows = new Map();
  return {
    rows,
    async loadDay(day) { return [...rows.values()].filter((row) => row.day === day).map(clone); },
    async save(row) { rows.set(row.keyFp + '|' + row.model + '|' + row.day, clone(row)); },
    async prune() {}
  };
}

export function createQuotaLedger(options = {}) {
  const store = options.store ?? createMemoryQuotaStore();
  const now = options.now ?? (() => Date.now());
  const warn = options.warn ?? ((message) => console.warn(message));
  const dayOf = options.dayOf ?? utcDay;
  const nextReset = options.nextReset ?? nextUtcMidnight;
  const entries = new Map();
  let loadedDay = null;
  let loading = null;
  let chain = Promise.resolve();

  const entryFor = (keyFp, model, day) => {
    const id = keyFp + '|' + model + '|' + day;
    let entry = entries.get(id);
    if (!entry) {
      entry = { keyFp, model, day, requests: 0, successes: 0, failures: 0, tokens: 0, recent: [], lastRequestAt: null };
      entries.set(id, entry);
    }
    return entry;
  };
  // Writes keep their order even when callers do not await one another.
  const persist = (entry) => {
    const row = clone(entry);
    chain = chain.then(() => store.save(row)).catch((error) => warn('[worker] ai quota ledger save failed: ' + String(error.message).slice(0, 160)));
    return chain;
  };

  async function ready() {
    const day = dayOf(now());
    if (loadedDay === day) return;
    loading ??= (async () => {
      try {
        const rows = await store.loadDay(day);
        entries.clear();
        for (const row of rows) {
          const entry = entryFor(row.keyFp, row.model, row.day);
          Object.assign(entry, {
            requests: Number(row.requests) || 0, successes: Number(row.successes) || 0, failures: Number(row.failures) || 0,
            tokens: Number(row.tokens) || 0, recent: (row.recent ?? []).map(([ts, n]) => [Number(ts), Number(n)]),
            lastRequestAt: row.lastRequestAt == null ? null : Number(row.lastRequestAt)
          });
        }
        loadedDay = day;
        await store.prune?.(day).catch(() => {});
      } catch (error) {
        warn('[worker] ai quota ledger could not load, counting from zero for now: ' + String(error.message).slice(0, 160));
      } finally {
        loading = null;
      }
    })();
    await loading;
  }

  const view = (keyFp, model, t) => entryFor(keyFp, model, dayOf(t));

  return {
    ready,
    /**
     * Can this pair take a request of about `estTokens` now? `{ ok:false, reason, until }` when the
     * day or the token window is spent, otherwise `{ ok:true, rpmAt }` (earliest per-minute spacing).
     */
    availability(keyFp, model, limits, t, estTokens = 0) {
      const entry = view(keyFp, model, t);
      if (limits.rpd && entry.requests >= limits.rpd) return { ok: false, reason: 'rpd', until: nextReset(t) };
      entry.recent = entry.recent.filter(([ts]) => ts > t - TPM_WINDOW_MS);
      if (limits.tpm && entry.recent.length) {
        const used = entry.recent.reduce((sum, [, n]) => sum + n, 0);
        let over = used + estTokens - limits.tpm;
        if (over > 0) {
          let until = t + TPM_WINDOW_MS;
          for (const [ts, n] of [...entry.recent].sort((a, b) => a[0] - b[0])) {
            over -= n;
            if (over <= 0) { until = ts + TPM_WINDOW_MS; break; }
          }
          return { ok: false, reason: 'tpm', until };
        }
      }
      const rpmAt = limits.rpm && entry.lastRequestAt ? entry.lastRequestAt + Math.ceil(60000 / limits.rpm) + RPM_MARGIN_MS : 0;
      return { ok: true, rpmAt };
    },
    async begin(keyFp, model, estTokens, t = now()) {
      const entry = view(keyFp, model, t);
      const stamp = [t, Math.max(0, Math.round(estTokens || 0))];
      entry.requests += 1;
      entry.lastRequestAt = t;
      entry.recent.push(stamp);
      await persist(entry);
      return { entry, stamp };
    },
    /** `tokens`: real prompt tokens when reported (replaces the estimate in the window). */
    async finish(handle, { ok, tokens = null, totalTokens = null } = {}) {
      const { entry, stamp } = handle;
      if (ok) entry.successes += 1; else entry.failures += 1;
      if (tokens != null) stamp[1] = Math.max(0, Math.round(tokens));
      entry.tokens += Math.max(0, Math.round(totalTokens ?? tokens ?? 0));
      await persist(entry);
    },
    /** The provider reported the daily quota spent: make our count agree. */
    async exhaust(keyFp, model, rpd, t = now()) {
      const entry = view(keyFp, model, t);
      if (entry.requests >= rpd) return;
      entry.requests = rpd;
      await persist(entry);
    },
    snapshot(keyFp, model, t = now()) {
      const entry = view(keyFp, model, t);
      return { requests: entry.requests, successes: entry.successes, failures: entry.failures, tokens: entry.tokens, lastRequestAt: entry.lastRequestAt };
    },
    flush: () => chain
  };
}
