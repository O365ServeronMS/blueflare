function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

export function isDeadHost(host, deadHosts) {
  return deadHosts.some((dead) => host === dead || host.endsWith('.' + dead));
}

// URL rỗng hoặc trỏ vào host đã ngừng phục vụ thì không còn dùng được.
export function isUnusableImageSource(url, deadHosts) {
  if (!url || !String(url).trim()) return true;
  const host = hostOf(url);
  return !host || isDeadHost(host, deadHosts);
}

// candidate: URL ứng viên đã qua allowlist (hoặc null). Chỉ thay ảnh đang hỏng,
// không bao giờ ghi đè URL còn dùng được và không đưa vào URL đã chết.
export function planImageHeal(movie, candidate, deadHosts) {
  const usable = (url) => url && !isDeadHost(hostOf(url), deadHosts);
  const thumb = usable(candidate.thumb) && isUnusableImageSource(movie.thumb_source_url, deadHosts)
    ? candidate.thumb : null;
  const poster = usable(candidate.poster) && isUnusableImageSource(movie.poster_source_url, deadHosts)
    ? candidate.poster : null;
  return thumb || poster ? { thumb, poster } : null;
}
