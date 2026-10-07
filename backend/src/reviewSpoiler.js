// Phrases that say the review is safe. Removed before the positive checks so
// "contains no spoilers" cannot match "contains ... spoilers".
const NEGATIVE = new RegExp(
  '\\b(?:' + [
    'spoilers?[\\s-]*free',
    'non[\\s-]*spoilers?',
    'no\\s+(?:major\\s+|plot\\s+)?spoilers?',
    'without\\s+(?:any\\s+|giving\\s+(?:away\\s+)?)?(?:major\\s+)?spoil(?:ers?|ing)',
    "(?:won['’]?t|will\\s+not|(?:do|does|did)\\s*(?:n['’]t|not)|not\\s+going\\s+to)\\s+(?:give\\s+(?:away\\s+)?(?:any\\s+)?)?spoil(?:ers?)?",
    '(?:avoid|avoiding|avoids)\\s+(?:any\\s+|major\\s+)?spoilers?'
  ].join('|') + ')\\b',
  'gi'
);

// Unambiguous warnings: flagged wherever they sit in the text.
const STRONG = [
  /\bspoiler\s+alerts?\b/i,
  /\b(?:contains?|containing|has|with|full|major|massive|heavy)\s+(?:\w+\s+)?spoilers?\b/i,
  /\bspoilers?\s+(?:ahead|below|follow|warning)\b/i,
  /\b(?:beware|warning)\W+(?:of\s+)?spoilers?\b/i
];

// A bare "spoiler" word only counts as a label at the edges of the review; in
// the middle it is usually part of a sentence ("the trailer was a spoiler").
const EDGE = 150;
const BARE = /\bspoilers?\b/i;

/** True when a review warns that it gives away the plot. Heuristic, English only. */
export function hasSpoilerWarning(content) {
  const text = String(content || '').replace(NEGATIVE, ' ');
  if (!BARE.test(text)) return false;
  if (STRONG.some((pattern) => pattern.test(text))) return true;
  return BARE.test(text.slice(0, EDGE)) || BARE.test(text.slice(-EDGE));
}
