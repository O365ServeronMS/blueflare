const LONG_CHARS = 280;
const LONG_LINES = 4;

export function reviewInitial(author: string): string {
  const first = Array.from(String(author || "").trim())[0];
  return first ? first.toLocaleUpperCase("vi-VN") : "?";
}

export function isLongReview(content: string): boolean {
  return content.length > LONG_CHARS || content.split("\n").length > LONG_LINES;
}

export function formatReviewDate(value: string | null | undefined): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(time));
}
