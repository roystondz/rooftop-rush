// Team names players choose. The server cleans every name before showing it to anyone.

export const DEFAULT_TEAM_NAMES = ['SKYLINE', 'NEON'] as const;
export const MAX_TEAM_NAME = 14;
const MIN_TEAM_NAME = 2;

/**
 * Keeps letters (any language), digits, spaces and a few separators, squeezes repeated spaces,
 * caps the length and upper-cases it to match the scoreboard style. Too short or empty: `fallback`.
 */
export function cleanTeamName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} '.\-_]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEAM_NAME)
    .trim()
    .toUpperCase();
  return cleaned.length >= MIN_TEAM_NAME ? cleaned : fallback;
}

/** Names for both teams, given what each side asked for. Two identical names get told apart. */
export function teamNames(wanted0: unknown, wanted1: unknown): [string, string] {
  const a = cleanTeamName(wanted0, DEFAULT_TEAM_NAMES[0]);
  let b = cleanTeamName(wanted1, DEFAULT_TEAM_NAMES[1]);
  if (a === b) b = b === DEFAULT_TEAM_NAMES[1] ? DEFAULT_TEAM_NAMES[0] : DEFAULT_TEAM_NAMES[1];
  if (a === b) b = `${b.slice(0, MAX_TEAM_NAME - 2)} 2`;
  return [a, b];
}
