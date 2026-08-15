import { createHash } from 'node:crypto';
import { bumpCacheVersion, closeCache, getOrBuild } from './cache.js';
import { config } from './config.js';
import { closeDatabase, migrate } from './db.js';
import { normalizeKkphim, normalizeNguonc } from './normalize.js';
import { KkphimProvider } from './providers/KkphimProvider.js';
import { NguoncProvider } from './providers/NguoncProvider.js';
import {
  getCrawlCheckpoint,
  recordCrawlCheckpointFailure,
  recordProviderFailure,
  recordProviderSuccess,
  saveCrawlCheckpoint,
  upsertCanonical
} from './repository.js';
import { buildHome } from './viewmodels.js';

const providers = [new NguoncProvider(), new KkphimProvider()];
let stopping = false;

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner())
  );
  return results;
}

function summaryFallback(provider, item) {
  return provider.name === 'nguonc'
    ? normalizeNguonc({ movie: item })
    : normalizeKkphim({ movie: item, episodes: [] });
}

function pageHash(items) {
  const sourceIds = items.map((item) => (
    item?.id || item?._id || item?.slug || ''
  )).join('\n');
  return createHash('sha256').update(sourceIds).digest('hex');
}

function totalPages(payload) {
  const value = payload?.paginate?.total_page || payload?.pagination?.totalPages ||
    payload?.data?.pagination?.totalPages || payload?.data?.paginate?.total_page;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function syncPage(provider, page) {
  const list = await provider.syncLatest(page);
  const items = provider.listItems(list.data);
  let imported = 0;
  let failed = 0;

  await mapLimit(items, config.syncConcurrency, async (item) => {
    let normalized;
    try {
      const detail = await provider.detail(item.slug);
      normalized = detail.normalized;
    } catch (error) {
      failed += 1;
      console.warn(
        '[worker] ' + provider.name + ' detail failed for ' + item.slug,
        error.message
      );
      normalized = summaryFallback(provider, item);
    }
    await upsertCanonical(normalized);
    imported += 1;
  });

  return {
    imported,
    failed,
    status: list.status,
    itemCount: items.length,
    pageHash: pageHash(items),
    totalPages: totalPages(list.data)
  };
}

async function syncHead(provider) {
  let imported = 0;
  let failed = 0;
  let status = 200;
  for (let page = 1; page <= config.syncPagesPerRun; page += 1) {
    if (stopping) break;
    const result = await syncPage(provider, page);
    imported += result.imported;
    failed += result.failed;
    status = result.status;
    if (!result.itemCount) break;
  }
  return { imported, failed, status };
}

async function syncBackfill(provider) {
  if (!config.backfillEnabled || stopping) return { imported: 0, failed: 0, status: 200 };

  const startPage = config.backfillStartPage || (config.syncPagesPerRun + 1);
  const checkpoint = await getCrawlCheckpoint(provider.name, 'backfill', startPage);
  if (checkpoint.completed_at) return { imported: 0, failed: 0, status: 200, completed: true };

  let imported = 0;
  let failed = 0;
  let status = 200;
  let page = checkpoint.next_page;
  try {
    for (let index = 0; index < config.backfillPagesPerRun; index += 1) {
      if (stopping) break;
      const result = await syncPage(provider, page);
      imported += result.imported;
      failed += result.failed;
      status = result.status;
      const completed = !result.itemCount || Boolean(result.totalPages && page >= result.totalPages);
      await saveCrawlCheckpoint(provider.name, 'backfill', {
        nextPage: page + 1,
        pageHash: result.pageHash,
        totalPages: result.totalPages,
        completed
      });
      if (completed) return { imported, failed, status, completed: true };
      page += 1;
    }
  } catch (error) {
    await recordCrawlCheckpointFailure(provider.name, 'backfill', error).catch(() => {});
    throw error;
  }
  return { imported, failed, status, nextPage: page };
}

async function syncProvider(provider) {
  const started = Date.now();
  let imported = 0;
  let failed = 0;
  let lastStatus = 200;
  try {
    const head = await syncHead(provider);
    imported += head.imported;
    failed += head.failed;
    lastStatus = head.status;
    const backfill = await syncBackfill(provider);
    imported += backfill.imported;
    failed += backfill.failed;
    lastStatus = backfill.status || lastStatus;
    await recordProviderSuccess(provider.name, Date.now() - started, lastStatus, failed);
    console.log(
      '[worker] ' + provider.name + ' head+backfill imported=' + imported +
      ' detailFailures=' + failed + ' durationMs=' + (Date.now() - started)
    );
    return { imported, failed };
  } catch (error) {
    await recordProviderFailure(provider.name, error).catch(() => {});
    console.error('[worker] ' + provider.name + ' sync failed', error);
    return { imported, failed: failed + 1, error };
  }
}

async function syncCycle() {
  const results = [];
  for (const provider of providers) {
    if (stopping) break;
    results.push(await syncProvider(provider));
  }

  const imported = results.reduce((sum, result) => sum + result.imported, 0);
  if (imported > 0) {
    const version = await bumpCacheVersion();
    await getOrBuild('home', buildHome, {
      version,
      ttl: config.responseCacheTtlSeconds
    });
    console.log('[worker] cache version=' + version + ' home precomputed');
  } else {
    console.warn('[worker] no new rows imported; existing cache remains active');
  }
}

await migrate();

function stop(signal) {
  console.log('[worker] received ' + signal + ', stopping after current operation');
  stopping = true;
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

while (!stopping) {
  const started = Date.now();
  await syncCycle();
  const elapsed = Date.now() - started;
  const delay = Math.max(1000, config.syncIntervalMs - elapsed);
  if (stopping) break;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

await Promise.allSettled([closeCache(), closeDatabase()]);
