import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.js';
import { purgeDeadHostImages } from '../src/repository.js';

function fakePool(deleteCounts) {
  const calls = [];
  const original = pool.query;
  let deletes = 0;
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/^DELETE FROM image_assets/.test(sql)) {
      const rowCount = deleteCounts[Math.min(deletes, deleteCounts.length - 1)];
      deletes += 1;
      return { rows: [], rowCount };
    }
    return { rows: [], rowCount: 0 };
  };
  return { calls, restore: () => { pool.query = original; } };
}

const deletesOf = (calls) => calls.filter((call) => /^DELETE FROM image_assets/.test(call.sql));

test('purgeDeadHostImages: no dead hosts does nothing', async () => {
  const f = fakePool([0]);
  try {
    assert.deepEqual(await purgeDeadHostImages([], async () => false, 10), { slugs: [], assetsDeleted: 0 });
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('purgeDeadHostImages: probes every referencing column separately, never with OR', async () => {
  const f = fakePool([0]);
  try {
    await purgeDeadHostImages(['phim.nguonc.com'], async () => false, 10);
    const [{ sql, params }] = deletesOf(f.calls);
    for (const column of ['m.thumb_asset_id', 'm.poster_asset_id', 'm.tmdb_thumb_asset_id', 'm.tmdb_poster_asset_id', 'p.profile_asset_id']) {
      assert.match(sql, new RegExp('NOT EXISTS \\(SELECT 1 FROM \\w+ \\w+ WHERE ' + column.replace('.', '\\.') + '=a\\.id\\)'));
    }
    assert.doesNotMatch(sql, /\sOR\s/);
    assert.deepEqual(params[0], ['phim.nguonc.com']);
  } finally { f.restore(); }
});

test('purgeDeadHostImages: deletes in batches until a short batch', async () => {
  const f = fakePool([1000, 1000, 250]);
  try {
    const result = await purgeDeadHostImages(['phim.nguonc.com'], async () => false, 10);
    assert.equal(result.assetsDeleted, 2250);
    const deletes = deletesOf(f.calls);
    assert.equal(deletes.length, 3);
    assert.ok(deletes.every((call) => call.params[1] === 1000));
  } finally { f.restore(); }
});

test('purgeDeadHostImages: a full batch every time stops at the batch cap', async () => {
  const f = fakePool([1000]);
  try {
    const result = await purgeDeadHostImages(['phim.nguonc.com'], async () => false, 10);
    assert.equal(deletesOf(f.calls).length, 500);
    assert.equal(result.assetsDeleted, 500 * 1000);
  } finally { f.restore(); }
});
