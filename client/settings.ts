// Small per-browser preferences (team name, kit, sound, music). Stored in localStorage, which can be
// unavailable (private browsing, blocked storage), so every read and write is allowed to fail.

export interface Settings {
  teamName: string;
  muted: boolean;
  music: boolean;
  /** Index into KITS. */
  kit: number;
  /** Phone vibration on shots, tackles and goals. */
  vibration: boolean;
}

import { cleanKit, DEFAULT_KITS } from '../shared/kits';

const KEY = 'rooftop-rush.settings';
const DEFAULTS: Settings = { teamName: '', muted: false, music: true, kit: DEFAULT_KITS[0], vibration: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      teamName: typeof saved.teamName === 'string' ? saved.teamName : DEFAULTS.teamName,
      muted: typeof saved.muted === 'boolean' ? saved.muted : DEFAULTS.muted,
      music: typeof saved.music === 'boolean' ? saved.music : DEFAULTS.music,
      kit: cleanKit(saved.kit, DEFAULTS.kit),
      vibration: typeof saved.vibration === 'boolean' ? saved.vibration : DEFAULTS.vibration,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: the setting just won't be remembered next time.
  }
}
