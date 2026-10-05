import { getScoreBadges } from "@/lib/utils";

/**
 * The critic/audience percentage pair shown above a card's title.
 *
 * Both MDBList-backed Rotten Tomatoes badges are optional. The row reserves its
 * height unconditionally (`bf-score-row`) so sparse score coverage cannot shift
 * the card grid.
 */

function TomatoIcon({ fresh }: { fresh: boolean }) {
  if (!fresh) {
    // Splat: the score is below 60, and the shape has to read as different at
    // 14px, not just recoloured — colour alone is not a usable distinction.
    return (
      <svg viewBox="0 0 24 24" className="bf-score-icon" aria-hidden="true">
        <path
          fill="#0ac855"
          d="M12 2.6 14 6l3.6-1.5-.6 3.9 3.9.7-2.6 3 2.6 3-3.9.7.6 3.9L14 18l-2 3.4L10 18l-3.6 1.5.6-3.9-3.9-.7 2.6-3-2.6-3 3.9-.7-.6-3.9L10 6z"
        />
        <circle cx="9.4" cy="11.2" r="1.15" fill="#062e18" />
        <circle cx="14.6" cy="11.2" r="1.15" fill="#062e18" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="bf-score-icon" aria-hidden="true">
      <circle cx="12" cy="13.6" r="8.1" fill="#fa320a" />
      <path
        fill="#0ac855"
        d="M12 5.6c-1.6-2.2-4-2.9-5.5-2.4 1 .6 1.7 1.5 2 2.4-1.4-.6-2.9-.2-3.6.5 1.9.2 3.4 1 4.4 2.1a6 6 0 0 1 5.4 0c1-1.1 2.5-1.9 4.4-2.1-.7-.7-2.2-1.1-3.6-.5.3-.9 1-1.8 2-2.4-1.5-.5-3.9.2-5.5 2.4z"
      />
    </svg>
  );
}

function PopcornIcon() {
  return (
    <svg viewBox="0 0 24 24" className="bf-score-icon" aria-hidden="true">
      <path
        fill="#fac51c"
        d="M6.6 8.2h10.8l-1.3 12.1a1.6 1.6 0 0 1-1.6 1.4H9.5a1.6 1.6 0 0 1-1.6-1.4z"
      />
      <path fill="#e23b2e" d="M9.6 8.2h1.7l-.5 13.5H9.1zm4.4 0h1.7l-.9 13.5h-1.3z" />
      <path
        fill="#fff4d6"
        d="M8.1 4.4a2 2 0 0 1 2.3-1.8 2 2 0 0 1 3.4 0 2 2 0 0 1 2.3 1.8 1.9 1.9 0 0 1 1 3.3H7.1a1.9 1.9 0 0 1 1-3.3z"
      />
    </svg>
  );
}

export function ScoreBadges({
  movie,
  className = "",
  reserveSpace = true
}: {
  movie: Parameters<typeof getScoreBadges>[0];
  className?: string;
  /**
   * Keep the row's height when there is nothing to show. True in the poster
   * grid, where an absent row would shift every card below it; false when
   * inlined into an existing metadata line, where an empty element would only
   * leave a stray flex gap.
   */
  reserveSpace?: boolean;
}) {
  const { tomato, popcorn } = getScoreBadges(movie);
  if (!tomato && !popcorn) {
    return reserveSpace ? <span className={`bf-score-row ${className}`.trim()} aria-hidden="true" /> : null;
  }

  return (
    <span className={`bf-score-row ${className}`.trim()}>
      {tomato ? (
        <span className="bf-score">
          <TomatoIcon fresh={tomato.fresh} />
          <span aria-label={`Điểm phê bình Rotten Tomatoes ${tomato.score} phần trăm`}>{tomato.score}%</span>
        </span>
      ) : null}
      {popcorn ? (
        <span className="bf-score">
          <PopcornIcon />
          <span aria-label={`Điểm khán giả Rotten Tomatoes ${popcorn.score} phần trăm`}>{popcorn.score}%</span>
        </span>
      ) : null}
    </span>
  );
}
