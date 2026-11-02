// Shirt colours a team can play in. Players pick one in the menu; online, the first person on
// each team chooses, and the server makes sure the two teams never wear the same kit.

export interface Kit {
  name: string;
  shirt: number;
  shorts: number;
}

export const KITS: readonly Kit[] = [
  { name: 'Cyan', shirt: 0x22d3ee, shorts: 0x0e2a4a },
  { name: 'Pink', shirt: 0xf472b6, shorts: 0x3b0d2c },
  { name: 'Red', shirt: 0xef4444, shorts: 0x3a0b0b },
  { name: 'Blue', shirt: 0x3b82f6, shorts: 0x0b1a3a },
  { name: 'Green', shirt: 0x22c55e, shorts: 0x0b2a16 },
  { name: 'Purple', shirt: 0xa855f7, shorts: 0x24103a },
  { name: 'White', shirt: 0xf1f5f9, shorts: 0x1e293b },
];

/** Cyan for the first team, pink for the second, as the game always looked. */
export const DEFAULT_KITS = [0, 1] as const;

/** A kit index from a client, or `fallback` if it isn't one. */
export function cleanKit(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < KITS.length ? raw : fallback;
}

/** Kits for both teams, given what each side asked for. The second team changes on a clash. */
export function teamKits(wanted0: unknown, wanted1: unknown): [number, number] {
  const a = cleanKit(wanted0, DEFAULT_KITS[0]);
  let b = cleanKit(wanted1, DEFAULT_KITS[1]);
  if (a === b) b = a === DEFAULT_KITS[1] ? DEFAULT_KITS[0] : DEFAULT_KITS[1];
  return [a, b];
}

/** "#22d3ee" for CSS. */
export const kitCss = (kit: number): string => `#${KITS[kit].shirt.toString(16).padStart(6, '0')}`;
