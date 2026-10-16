import assert from 'node:assert/strict';
import test from 'node:test';
import { analyseCatalog, detectRow, groupForModel, needsModel } from '../src/catalogAuditExtract.js';
import { createState, deterministicActions, gateProposal } from '../src/catalogAuditGate.js';
import { createLock, lastSlot, nextSlot, packGroups, parseAuditAnswer, runCatalogAudit, runDue } from '../src/catalogAudit.js';
import { AiError } from '../src/ai/index.js';
import { normalizeTitle } from '../src/identity.js';

// ---- fixtures ------------------------------------------------------------------------------

let nextSource = 1;
const source = (provider, { title, original = null, slug, season = null, tmdbId = null, year = 2026, episodes = 8, available = true }) => ({
  id: nextSource++, provider, provider_slug: slug, availability: available, episodes,
  metadata: { title, original_title: original, year, tmdb_id: tmdbId, tmdb_type: tmdbId ? 'tv' : null, tmdb_season: season, type: 'series' }
});
const row = (over) => ({
  media_type: 'tv', display_type: 'series', year: 2026, tmdb_id: null, tmdb_media_type: null, tmdb_season_number: null,
  tmdb_id_source: null, imdb_id: null, catalog_state: 'ready', aliases: [], favorites: 0, history: 0, sources: [], ...over,
  normalized_title: normalizeTitle(over.title || '')
});

const DIPLOMAT = 203857;
const facts = new Map([[DIPLOMAT, { id: DIPLOMAT, name: 'The Diplomat', original: 'The Diplomat', seasons: [
  { n: 1, year: 2023, episodes: 8 }, { n: 2, year: 2024, episodes: 6 }, { n: 3, year: 2025, episodes: 8 }, { n: 4, year: 2026, episodes: 8 }] }]]);

/** The bug that started this: the season-4 row holds TMDB season 3 and a KKPhim record of season 3. */
function diplomat() {
  const s3 = row({
    id: 'a3', canonical_slug: 'nha-ngoai-giao-phan-3', title: 'Nhà Ngoại Giao (Phần 3)', original_title: 'The Diplomat (Season 3)', year: 2025,
    sources: [source('nguonc', { title: 'Nhà Ngoại Giao (Phần 3)', original: 'The Diplomat (Season 3)', slug: 'nha-ngoai-giao-phan-3', year: 2025 })]
  });
  const kk3 = source('kkphim', { title: 'Nhà Ngoại Giao (Phần 3)', original: 'The Diplomat (Season 3)', slug: 'nha-ngoai-giao-phan-3', season: 3, tmdbId: DIPLOMAT, year: 2025 });
  const s4 = row({
    id: 'a4', canonical_slug: 'nha-ngoai-giao-phan-4', title: 'Nhà Ngoại Giao (Phần 4)', original_title: 'The Diplomat (Season 4)',
    tmdb_id: DIPLOMAT, tmdb_media_type: 'tv', tmdb_season_number: 3, tmdb_id_source: 'provider',
    sources: [kk3, source('nguonc', { title: 'Nhà Ngoại Giao (Phần 4)', original: 'The Diplomat (Season 4)', slug: 'nha-ngoai-giao-phan-4' })]
  });
  return { s3, s4, kk3 };
}

// ---- detectors and groups ------------------------------------------------------------------

test('detectors flag the mixed-season row and its season contradiction', () => {
  const { s4, s3 } = diplomat();
  assert.deepEqual(detectRow(s4).sort(), ['multi-season', 'season-marker', 'slug-season']);
  assert.deepEqual(detectRow(s3), []);
  assert.ok(detectRow(row({ id: 'o', canonical_slug: 'o', title: 'O', sources: [source('nguonc', { title: 'O', slug: 'o', available: false })] })).includes('orphan'));
});

test('analyseCatalog groups the seasons of one series and needs the model for a mixed row', () => {
  const { s3, s4 } = diplomat();
  const { groups, counts, family, holderOf } = analyseCatalog([s3, s4]);
  assert.equal(counts['multi-season'], 1);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map((r) => r.id).sort(), ['a3', 'a4']);
  assert.equal(needsModel(groups[0]), true);
  assert.deepEqual(family(s4).map((r) => r.id), ['a3']);
  assert.equal(holderOf(DIPLOMAT, 'tv', 3), 'a4');
  assert.equal(holderOf(DIPLOMAT, 'tv', 4), null);
  const shaped = groupForModel(groups[0], facts);
  assert.equal(shaped.tmdb[0].seasons.length, 4);
  assert.equal(shaped.rows.find((r) => r.id === 'a4').sources.find((s) => s.provider === 'kkphim').season, 3);
});

// ---- gate ----------------------------------------------------------------------------------

test('gate: fix the season, then move the other-season record out (the Diplomat sequence)', () => {
  const { s3, s4, kk3 } = diplomat();
  const { family, holderOf } = analyseCatalog([s3, s4]);
  const state = createState([s3, s4], { facts, holderOf, family });
  const verdicts = gateProposal(state, [
    { type: 'set_season', movieId: 'a4', season: 4 },
    { type: 'move_source', sourceId: kk3.id }
  ]);
  assert.deepEqual(verdicts.map((v) => [v.action.type, v.ok, v.gate ?? null]), [['set_season', true, null], ['move_source', true, null]]);
  assert.equal(verdicts[1].detail.expect, 'a3');
});

test('gate: set_season needs TMDB facts and refuses a season the row does not name', () => {
  const { s3, s4, kk3 } = diplomat();
  const { family, holderOf } = analyseCatalog([s3, s4]);
  const noFacts = gateProposal(createState([s3, s4], { holderOf, family }), [{ type: 'set_season', movieId: 'a4', season: 4 }, { type: 'move_source', sourceId: kk3.id }]);
  assert.equal(noFacts[0].ok, false);
  const wrong = gateProposal(createState([s3, s4], { facts, holderOf, family }), [{ type: 'set_season', movieId: 'a4', season: 2 }]);
  assert.equal(wrong[0].ok, false);
});

test('gate: a record that agrees with its row never moves, and a row keeps its last source', () => {
  const { s3, s4 } = diplomat();
  const { family, holderOf } = analyseCatalog([s3, s4]);
  const state = createState([s3, s4], { facts, holderOf, family });
  // Once a4 stands for season 4, its Phần 4 record agrees with it and stays.
  const kk3 = s4.sources[0];
  assert.deepEqual(gateProposal(state, [{ type: 'set_season', movieId: 'a4', season: 4 }, { type: 'move_source', sourceId: kk3.id }]).map((v) => v.ok), [true, true]);
  state.byId.get('a4').sources.push(source('kkphim', { title: 'Nhà Ngoại Giao (Phần 4)', slug: 'nha-ngoai-giao-phan-4', season: 4, tmdbId: DIPLOMAT }));
  const [stays] = gateProposal(state, [{ type: 'move_source', sourceId: s4.sources[1].id }]);
  assert.equal(stays.ok, false);
  assert.notEqual(stays.gate, 'last-source');
  // A proposal that contradicts itself (moving out the record its new season rests on) is refused whole.
  const contradicts = gateProposal(createState([s3, s4], { facts, holderOf, family }),
    [{ type: 'move_source', sourceId: s4.sources[1].id }, { type: 'set_season', movieId: 'a4', season: 4 }, { type: 'rename_slug', movieId: 'a4' }]);
  assert.deepEqual(contradicts.map((v) => v.gate ?? 'ok'), ['ok', contradicts[1].gate, 'earlier-action-failed']);
  assert.equal(contradicts[1].ok, false);
  const [last] = gateProposal(state, [{ type: 'move_source', sourceId: s3.sources[0].id }]);
  assert.equal(last.ok, false);
});

test('gate: report and none are recorded, never applied', () => {
  const { s3, s4 } = diplomat();
  const state = createState([s3, s4], { facts });
  assert.deepEqual(gateProposal(state, [{ type: 'report', movieId: 'a4', note: 'x' }]).map((v) => v.gate), ['report-only']);
});

// ---- deterministic proposals ---------------------------------------------------------------

function familyGuy() {
  const rows = [];
  for (let n = 1; n <= 14; n += 1) {
    rows.push(row({ id: 'fg' + String(n).padStart(2, '0'), canonical_slug: 'family-guy-phan-' + n, title: 'Family Guy (Phần ' + n + ')', year: 1998 + n,
      tmdb_id: 1434, tmdb_media_type: 'tv', tmdb_season_number: n, tmdb_id_source: 'provider',
      sources: [source('kkphim', { title: 'Family Guy (Phần ' + n + ')', slug: 'family-guy-phan-' + n, season: n, tmdbId: 1434, year: 1998 + n })] }));
  }
  // Season 3's row carries an alias of season 12 (left over from an old merge).
  rows[2].aliases = [{ slug: 'family-guy-phan-12' }];
  return rows;
}

test('alias naming another season is re-pointed to that season, found catalog-wide (never dropped)', () => {
  const rows = familyGuy();
  const { groups, family, holderOf } = analyseCatalog(rows);
  const group = groups.find((g) => g.rows.some((r) => r.id === 'fg03'));
  assert.ok(group);
  const actions = deterministicActions(group, family);
  assert.deepEqual(actions.map((a) => [a.type, a.slug, a.toMovieId]), [['fix_alias', 'family-guy-phan-12', 'fg12']]);
  const [verdict] = gateProposal(createState(group.rows, { holderOf, family }), actions);
  assert.equal(verdict.ok, true);
  // An alias with no row of its season is left alone.
  const lonely = familyGuy().slice(0, 3);
  const g2 = analyseCatalog(lonely);
  const g = g2.groups.find((x) => x.rows.some((r) => r.id === 'fg03'));
  assert.deepEqual(deterministicActions(g, g2.family), []);
});

test('orphans are hidden and wrong slugs renamed without the model', () => {
  const orphan = row({ id: 'o1', canonical_slug: 'lac-loi', title: 'Lạc Lối', sources: [source('nguonc', { title: 'Lạc Lối', slug: 'lac-loi', available: false })] });
  const slugged = row({ id: 's2', canonical_slug: 'tham-tu-phan-3', title: 'Thám Tử (Phần 2)', tmdb_id: 77, tmdb_media_type: 'tv', tmdb_season_number: 2,
    sources: [source('kkphim', { title: 'Thám Tử (Phần 2)', slug: 'tham-tu-phan-2', season: 2, tmdbId: 77 })] });
  const { groups, family } = analyseCatalog([orphan, slugged]);
  const types = groups.flatMap((g) => deterministicActions(g, family)).map((a) => a.type).sort();
  assert.deepEqual(types, ['hide_row', 'rename_slug']);
  assert.ok(groups.every((g) => !needsModel(g)));
});

// ---- model answer --------------------------------------------------------------------------

test('parseAuditAnswer keeps valid actions and drops ids outside the group', () => {
  const { s3, s4, kk3 } = diplomat();
  const group = groupForModel(analyseCatalog([s3, s4]).groups[0], facts);
  const out = parseAuditAnswer({ groups: [
    { key: group.key, actions: [
      { type: 'set_season', movieId: 'a4', season: 4, reason: 'title says 4' },
      { type: 'move_source', sourceId: kk3.id, reason: 'season 3 record' },
      { type: 'move_source', sourceId: 99999 },
      { type: 'set_season', movieId: 'nope', season: 4 },
      { type: 'set_season', movieId: 'a4', season: 'four' },
      { type: 'drop_table' },
      { type: 'none' }
    ] },
    { key: 'unknown', actions: [{ type: 'hide_row', movieId: 'a4' }] }
  ] }, [group]);
  assert.deepEqual(out.get(group.key).map((a) => a.type), ['set_season', 'move_source']);
  assert.equal(out.size, 1);
  assert.throws(() => parseAuditAnswer({ nope: 1 }, [group]), (e) => e.permanent === true);
});

test('packGroups respects the group count and the token budget', () => {
  const groups = Array.from({ length: 5 }, (_, i) => ({ key: 'g' + i, pad: 'x'.repeat(300) }));
  assert.deepEqual(packGroups(groups, { maxGroups: 2, maxTokens: 10000 }).map((p) => p.length), [2, 2, 1]);
  assert.deepEqual(packGroups(groups, { maxGroups: 10, maxTokens: 150 }).map((p) => p.length), [1, 1, 1, 1, 1]);
});

// ---- schedule and lock ---------------------------------------------------------------------

test('the weekly slot is Sunday 03:00 Vietnam time (Saturday 20:00 UTC)', () => {
  const sunday3 = Date.UTC(2026, 9, 17, 20); // Sat 2026-10-17 20:00 UTC = Sun 2026-10-18 03:00 ICT
  assert.equal(lastSlot(sunday3), sunday3);
  assert.equal(lastSlot(sunday3 - 1), sunday3 - 7 * 86400000);
  assert.equal(lastSlot(sunday3 + 3 * 86400000), sunday3);
  assert.equal(nextSlot(sunday3 + 1, 0, 3), sunday3 + 7 * 86400000);
  // Wednesday 22:00 ICT = 15:00 UTC.
  assert.equal(new Date(lastSlot(Date.UTC(2026, 9, 20), 3, 22)).toISOString(), '2026-10-14T15:00:00.000Z');
});

test('runDue: once per slot, at most three failed tries', async () => {
  const db = (finished, failed) => ({ query: async (sql, params) => { assert.ok(params[0] instanceof Date); return { rows: [{ finished, failed }] }; } });
  const settings = { catalogAuditDay: 0, catalogAuditHour: 3 };
  assert.equal(await runDue(Date.now(), { db: db(0, 0), settings }), true);
  assert.equal(await runDue(Date.now(), { db: db(1, 0), settings }), false);
  assert.equal(await runDue(Date.now(), { db: db(0, 2), settings }), true);
  assert.equal(await runDue(Date.now(), { db: db(0, 3), settings }), false);
});

test('the catalog lock runs tasks one at a time and survives a failing task', async () => {
  const lock = createLock();
  const order = [];
  const slow = lock.run(async () => { order.push('a:start'); await new Promise((r) => setTimeout(r, 20)); order.push('a:end'); });
  const failing = lock.run(async () => { order.push('b'); throw new Error('boom'); });
  const last = lock.run(async () => { order.push('c'); return 3; });
  await slow;
  await assert.rejects(failing, /boom/);
  assert.equal(await last, 3);
  assert.deepEqual(order, ['a:start', 'a:end', 'b', 'c']);
});

// ---- one run (dry-run, fake db and model) --------------------------------------------------

function fakeDb(rows) {
  const actions = [];
  const runs = [];
  return {
    actions, runs,
    query: async (sql, params) => {
      if (sql.startsWith('UPDATE catalog_audit_runs SET status=\'failed\', finished_at=now(), error=')) return { rows: [] };
      if (sql.startsWith('INSERT INTO catalog_audit_runs')) { runs.push({ mode: params[0] }); return { rows: [{ id: 7 }] }; }
      if (sql.includes('FROM movies m WHERE m.catalog_state=\'ready\'')) return { rows: params[0].startsWith('0000') ? rows : [] };
      if (sql.startsWith('INSERT INTO catalog_audit_actions')) { actions.push({ action: params[3], params: JSON.parse(params[4]), status: params[6], gate: params[7], model: params[12], slugs: params[10] }); return { rows: [] }; }
      if (sql.startsWith('UPDATE catalog_audit_runs SET status=$2')) { Object.assign(runs[0], { status: params[1], summary: JSON.parse(params[3]) }); return { rows: [] }; }
      if (sql.startsWith("UPDATE catalog_audit_runs SET status='failed'")) { Object.assign(runs[0], { status: 'failed', error: params[2] }); return { rows: [] }; }
      throw new Error('unexpected query ' + sql.slice(0, 80));
    }
  };
}

const settings = { catalogAuditMode: 'dry-run', catalogAuditBatch: 8, catalogAuditBatchTokens: 16000, catalogAuditMaxActions: 500, tmdbEnabled: false };
const tmdb = { get: async (path) => { assert.equal(path, '/tv/' + DIPLOMAT); return { id: DIPLOMAT, name: 'The Diplomat', seasons: facts.get(DIPLOMAT).seasons.map((s) => ({ season_number: s.n, air_date: s.year + '-05-01', episode_count: s.episodes })) }; } };

test('a dry-run records the gated model proposal and writes nothing', async () => {
  const { s3, s4, kk3 } = diplomat();
  const db = fakeDb([s3, s4]);
  const ai = {
    available: () => true, ready: async () => {},
    json: async (role, messages, options) => {
      assert.equal(role, 'DEDUPE');
      const sent = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('\n') + 1));
      const answer = { groups: [{ key: sent[0].key, actions: [{ type: 'set_season', movieId: 'a4', season: 4, reason: 'r' }, { type: 'move_source', sourceId: kk3.id, reason: 'r' }] }] };
      return { value: options.accept(answer), model: 'test-model' };
    }
  };
  const result = await runCatalogAudit({ db, ai, tmdb, config: settings, log: () => {} });
  assert.equal(result.status, 'done');
  assert.deepEqual(db.actions.map((a) => [a.action, a.status, a.model]), [['set_season', 'dry-run', 'test-model'], ['move_source', 'dry-run', 'test-model']]);
  assert.equal(db.runs[0].summary.requests, 1);
  assert.ok(db.actions.every((a) => a.slugs.length > 0), 'every action names its slugs');
});

test('a refused answer is skipped, an unavailable model makes the run partial', async () => {
  const { s3, s4 } = diplomat();
  for (const [error, status] of [[new AiError('bad', { kind: 'content' }), 'done'], [new AiError('down', { kind: 'unavailable' }), 'partial']]) {
    const db = fakeDb([s3, s4]);
    const ai = { available: () => true, ready: async () => {}, json: async () => { throw error; } };
    const result = await runCatalogAudit({ db, ai, tmdb, config: settings, log: () => {} });
    assert.equal(result.status, status);
    assert.deepEqual(db.actions, []);
  }
});

test('a run stopped by shutdown is failed, so the slot runs again', async () => {
  const { s3, s4 } = diplomat();
  const db = fakeDb([s3, s4]);
  let stopping = false;
  const ai = { available: () => true, ready: async () => {}, json: async () => { stopping = true; throw new AiError('aborted', { kind: 'content' }); } };
  const result = await runCatalogAudit({ db, ai, tmdb, config: { ...settings, catalogAuditBatch: 1 }, isStopping: () => stopping, log: () => {} });
  assert.equal(result.status, 'failed');
  assert.equal(db.runs[0].summary.stopped, 'stopping');
});
