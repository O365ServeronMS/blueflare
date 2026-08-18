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
      </defs>

      <text
        x="50"
        y="79"
        textAnchor="middle"
        fontFamily="var(--font-display), Archivo, var(--font-inter), sans-serif"
        fontWeight={900}
        fontStretch="70%"
        fontSize="104"
        fill="#8f1712"
        clipPath="url(#bf-icon-left)"
      >
        B
      </text>
      <text
        x="50"
        y="79"
        textAnchor="middle"
        fontFamily="var(--font-display), Archivo, var(--font-inter), sans-serif"
        fontWeight={900}
        fontStretch="70%"
        fontSize="104"
        fill="var(--color-netflix-red)"
        clipPath="url(#bf-icon-right)"
      >
        B
      </text>
      <text
        x="50"
        y="79"
        textAnchor="middle"
        fontFamily="var(--font-display), Archivo, var(--font-inter), sans-serif"
        fontWeight={900}
        fontStretch="70%"
        fontSize="104"
        fill="#ff6a5f"
        fillOpacity="0.55"
        clipPath="url(#bf-icon-seam)"
      >
        B
      </text>
    </svg>
  );
}
