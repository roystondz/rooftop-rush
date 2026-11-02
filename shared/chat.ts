// Quick chat: a fixed set of messages people can send online. Nothing typed, so there's
// nothing to moderate. Messages travel as their number in this list.

export const QUICK_CHAT = ['Nice!', 'Pass!', 'Shoot!', 'Defend!', 'Unlucky!', 'GG'] as const;

/** A person can send at most one quick-chat message this often (milliseconds). */
export const CHAT_COOLDOWN_MS = 1000;

export const isChatId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < QUICK_CHAT.length;
