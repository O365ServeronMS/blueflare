import { judgeSamples, nextHostState } from './imageHostHealth.js';

const SLACK_MS = 10 * 60 * 1000;

/**
 * Chạy tối đa một lần mỗi `intervalMs`: thăm dò vài URL ảnh thật của từng host trong
 * allowlist, cập nhật bộ đếm chết liên tiếp, rồi (khi được phép) dọn link ảnh của host chết.
 */
export async function runImageHostCheck({ hosts, settings, deps, now = Date.now() }) {
  const health = new Map((await deps.loadHealth()).map((row) => [row.host, row]));
  const learnDead = () => deps.setDead([...health.values()].filter((row) => row.status === 'dead').map((row) => row.host));
  learnDead();

  const due = hosts.filter((host) => {
    const row = health.get(host);
    return !row || now - new Date(row.checked_at).getTime() >= settings.intervalMs - SLACK_MS;
  });
  if (!due.length) return null;

  const verdicts = new Map();
  for (const host of due) {
    const urls = await deps.sampleUrls(host, settings.samples);
    const outcomes = [];
    for (const url of urls) outcomes.push(await deps.probe(url));
    verdicts.set(host, { verdict: judgeSamples(outcomes), detail: outcomes.join(',') });
  }

  // Mọi host cùng "chết" một lúc nhiều khả năng là lỗi mạng phía mình, không phải lỗi của host.
  const allDead = verdicts.size > 1 && [...verdicts.values()].every((entry) => entry.verdict === 'dead');
  for (const [host, entry] of verdicts) {
    const verdict = allDead ? 'unknown' : entry.verdict;
    const state = nextHostState(health.get(host), verdict, { deadAfter: settings.deadAfter, now: new Date(now) });
    await deps.saveHealth(host, state, allDead ? 'all hosts failed; ignored' : entry.detail);
    health.set(host, { host, checked_at: new Date(now), ...state });
  }
  learnDead();

  const dead = [...health.values()].filter((row) => row.status === 'dead').map((row) => row.host);
  let purge = { slugs: [], assetsDeleted: 0 };
  if (settings.purgeAllowed) purge = await deps.purge(deps.deadHosts());
  return {
    probed: due.length,
    dead,
    verdicts: Object.fromEntries([...verdicts].map(([host, entry]) => [host, entry.verdict])),
    changedSlugs: purge.slugs,
    assetsDeleted: purge.assetsDeleted
  };
}
