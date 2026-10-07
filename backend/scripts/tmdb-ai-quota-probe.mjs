// Measures what the three TMDB_MATCH Gemini keys really allow, with real ranking prompts.
// Stops at the first daily-quota 429 and reports how many requests it used. Never prints keys.
//   --phase latency|rpm|all   --batch 5   --films 50   --extra '{"thinkingConfig":{...}}'
import { writeFileSync, readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { parseGeminiModels, keyFingerprint, classifyQuotaError, GEMINI_BASE } from '../src/geminiRotation.js';
import { matchInput, promptEntry, rankRequestBody, parseRankResponse } from '../src/tmdbMatchAi.js';
import { OUT } from './lib/aiTools.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const phase = arg('phase', 'all');
const batchSize = Number(arg('batch', 5));
const films = Number(arg('films', 50));
const extraGen = arg('extra') ? JSON.parse(arg('extra')) : null;
const evidenceLabel = arg('evidence', 'r1');

const models = parseGeminiModels(config.tmdbMatchGeminiModels).map((m) => m.id);
const keys = config.tmdbMatchGeminiApiKeys.map((value, i) => ({ value, name: 'k' + (i + 1), fp: keyFingerprint(value) }));

const evidence = readFileSync(OUT + '/backtest-evidence-' + evidenceLabel + '.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.candidates.length);
const used = evidence.slice(0, films);
const batches = [];
for (let i = 0; i < used.length; i += batchSize) {
  batches.push(used.slice(i, i + batchSize).map((e, j) => promptEntry('m' + (j + 1), matchInput(e.input), e.candidates)));
}
console.log(`models ${models.join(',')} keys ${keys.map((k) => k.name + ':' + k.fp).join(',')} films ${used.length} batches ${batches.length}x${batchSize}`);

const log = [];
let requests = 0;
let stop = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(model, key, entries, tag) {
  if (stop) return null;
  const body = rankRequestBody(entries);
  if (extraGen) Object.assign(body.generationConfig, extraGen);
  const started = Date.now();
  requests += 1;
  const rec = { tag, model, key: key.name, entries: entries.length, at: new Date().toISOString() };
  try {
    const response = await fetch(GEMINI_BASE + model + ':generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key.value },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
    });
    rec.ms = Date.now() - started;
    rec.status = response.status;
    const text = await response.text();
    if (response.ok) {
      const json = JSON.parse(text);
      rec.usage = json.usageMetadata ? { prompt: json.usageMetadata.promptTokenCount, out: json.usageMetadata.candidatesTokenCount, thoughts: json.usageMetadata.thoughtsTokenCount } : null;
      try { rec.valid = parseRankResponse(json, entries).size === entries.length; } catch (e) { rec.valid = false; rec.parseError = String(e.message).slice(0, 80); }
    } else {
      rec.error = text.replace(/AIza\S+/g, '[key]').slice(0, 300);
      if (response.status === 429) {
        const q = classifyQuotaError(text);
        rec.daily = q.daily; rec.retryDelayMs = q.delayMs;
        const metric = /"quotaId":\s*"([^"]+)"/.exec(text); const value = /"quotaValue":\s*"?(\d+)/.exec(text);
        rec.quotaId = metric?.[1]; rec.quotaValue = value?.[1];
        if (q.daily) stop = { model, key: key.name, requestsUsed: requests, quotaId: rec.quotaId, quotaValue: rec.quotaValue };
      }
    }
  } catch (error) {
    rec.ms = Date.now() - started; rec.status = 0; rec.error = error.name + ' ' + String(error.message).slice(0, 80);
  }
  log.push(rec);
  console.log(JSON.stringify({ ...rec, error: rec.error?.slice(0, 90) }));
  return rec;
}

if (phase === 'latency' || phase === 'all') {
  // 2 sequential requests per (model, key) pair, spaced beyond a 5 RPM limit so latency is not confounded by 429.
  for (const model of models) {
    await Promise.all(keys.map(async (key, ki) => {
      for (let i = 0; i < 2; i += 1) { await send(model, key, batches[(ki * 2 + i) % batches.length], 'latency'); await sleep(13000); }
    }));
  }
}
if (phase === 'rpm' || phase === 'all') {
  // Step the request rate up on key 1 of each model until a per-minute 429 appears (max ~10 requests per model).
  for (const model of models) {
    for (const rpm of [10, 15]) {
      const gap = Math.floor(60000 / rpm);
      let limited = false;
      for (let i = 0; i < 6 && !limited && !stop; i += 1) {
        const rec = await send(model, keys[0], batches[i % batches.length], 'rpm' + rpm);
        if (rec?.status === 429) limited = true;
        await sleep(gap);
      }
      if (limited) { await sleep(65000); break; }
    }
    await sleep(30000);
  }
}

const ok = log.filter((r) => r.status === 200);
const summary = {
  requests, stop,
  perModel: Object.fromEntries(models.map((m) => {
    const rs = log.filter((r) => r.model === m);
    const good = rs.filter((r) => r.status === 200);
    const lat = good.map((r) => r.ms).sort((a, b) => a - b);
    return [m, { n: rs.length, ok: good.length, validJson: good.filter((r) => r.valid).length, status: rs.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}), p50ms: lat[Math.floor(lat.length / 2)], maxMs: lat.at(-1), meanOutTokens: good.length ? Math.round(good.reduce((s, r) => s + (r.usage?.out || 0), 0) / good.length) : null, meanThoughtTokens: good.length ? Math.round(good.reduce((s, r) => s + (r.usage?.thoughts || 0), 0) / good.length) : null }];
  }))
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(OUT + '/quota-probe-' + arg('label', 'a') + '.json', JSON.stringify({ summary, log }, null, 1));
