// Chữ "B" bên dưới là path tĩnh cắt từ glyph thật của Archivo Black, biến thể
// width-axis "condensed" (75%, phục vụ qua Google Fonts wdth@ — không phải một
// bản 100%-width bị bóp scaleX nhân tạo). Không phụ thuộc font nào runtime nữa:
// trước đây --font-display chưa từng được định nghĩa và Archivo chưa từng
// được nạp, nên icon này đã âm thầm rơi về font body suốt từ đầu.
export function BlueflareIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label="Blueflare"
    >
      <defs>
        <clipPath id="bf-icon-left">
          <polygon points="0,0 61,0 39,100 0,100" />
        </clipPath>
        <clipPath id="bf-icon-right">
          <polygon points="61,0 100,0 100,100 39,100" />
        </clipPath>
        <clipPath id="bf-icon-seam">
          <polygon points="54,0 66,0 44,100 32,100" />
        </clipPath>
        <path
          id="bf-icon-b"
          transform="translate(19.11 79)"
          d="M38.69 0L5.41 0L5.41-71.55L39.21-71.55Q44.82-71.55 49.09-69.47Q53.35-67.39 55.85-63.54Q58.34-59.70 58.34-54.18Q58.34-49.50 56.89-46.18Q55.43-42.85 52.94-40.72Q50.44-38.58 47.42-37.34L47.42-36.92Q50.75-35.88 53.51-33.96Q56.26-32.03 57.98-28.65Q59.70-25.27 59.70-19.97Q59.70-13.94 56.94-9.41Q54.18-4.89 49.45-2.44Q44.72 0 38.69 0M25.48-28.91L25.48-16.64L34.74-16.64Q36.71-16.64 37.96-18.30Q39.21-19.97 39.21-23.30Q39.21-24.86 38.64-26.16Q38.06-27.46 37.02-28.18Q35.98-28.91 34.74-28.91L25.48-28.91M25.48-55.85L25.48-43.68L33.80-43.68Q35.15-43.68 36.14-44.46Q37.13-45.24 37.70-46.70Q38.27-48.15 38.27-50.34Q38.27-52.62 36.97-54.24Q35.67-55.85 33.80-55.85"
        />
      </defs>

      <use href="#bf-icon-b" fill="#8f1712" clipPath="url(#bf-icon-left)" />
      <use href="#bf-icon-b" fill="var(--color-netflix-red)" clipPath="url(#bf-icon-right)" />
      <use href="#bf-icon-b" fill="#ff6a5f" fillOpacity="0.55" clipPath="url(#bf-icon-seam)" />
    </svg>
  );
}
