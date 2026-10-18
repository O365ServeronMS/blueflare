// Apply one group's recorded but unapplied catalog audit actions now (e.g. over the run cap):
//   node scripts/catalog-audit-apply.mjs <groupKey>
// Re-gates them on the current rows and writes them; run it inside the worker container. It runs
// outside the worker's catalog lock, so keep it to a handful of groups. Invalidates the changed slugs.
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { applyRecordedGroup } from '../src/catalogAudit.js';
import { createTmdbClient } from '../src/tmdbMatchAi.js';
import { upsertCanonical } from '../src/repository.js';
import { invalidateResponseKeys } from '../src/cache.js';
import { revalidateFrontend } from '../src/frontendRevalidation.js';
import { reviewsInvalidationKeys } from '../src/reviewOrder.js';
import { KkphimProvider } from '../src/providers/KkphimProvider.js';
import { NguoncProvider } from '../src/providers/NguoncProvider.js';

const groupKey = process.argv[2];
if (!groupKey) {
  console.error('usage: node scripts/catalog-audit-apply.mjs <groupKey>');
  process.exit(2);
}
try {
  const providers = new Map([new NguoncProvider(), new KkphimProvider()].map((p) => [p.name.toLowerCase(), p]));
  const tmdb = config.tmdbEnabled && config.tmdbApiKey ? createTmdbClient({ concurrency: 2 }) : null;
  const { results, slugs } = await applyRecordedGroup(groupKey, { tmdb, providers, upsert: upsertCanonical });
  if (slugs.length) {
    await invalidateResponseKeys(['home', ...slugs.flatMap((s) => ['movie:' + s, 'recommendations:' + s, ...reviewsInvalidationKeys(s)])]);
    await revalidateFrontend(['home', ...slugs.map((s) => 'movie:' + s)]);
  }
  console.log(JSON.stringify({ results, slugs }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit(process.exitCode ?? 0); // the cache client would keep the process alive
}
