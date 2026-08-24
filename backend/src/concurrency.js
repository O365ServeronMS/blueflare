/**
 * Run `callback` over `items` with at most `limit` in flight at once.
 *
 * Shared by the provider sync passes and the image prewarmer so both stay
 * bounded against the same kind of upstream: the runners pull from one cursor,
 * so a slow item never blocks the others from progressing.
 */
export async function mapLimit(items, limit, callback) {
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
