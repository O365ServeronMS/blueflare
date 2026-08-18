export function BlueflareWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 340 56"
      className={className}
      role="img"
      aria-label="Blueflare"
    >
      <defs>
        <path id="bf-wordmark-arc" d="M 2 30 Q 170 46 338 30" />
      </defs>
      <text
        fill="var(--color-netflix-red)"
        fontFamily="var(--font-display), Archivo, var(--font-inter), sans-serif"
        fontWeight={900}
        fontStretch="72%"
        fontSize="46"
        letterSpacing="-1.5"
      >
        <textPath href="#bf-wordmark-arc" startOffset="0">
          BLUEFLARE
        </textPath>
      </text>
    </svg>
  );
}
