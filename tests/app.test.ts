// The installable app (manifest, icons, service worker), vibration and quick chat.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BUZZ, Haptics } from '../client/haptics';
import { loadSettings } from '../client/settings';
import { CHAT_COOLDOWN_MS, isChatId, QUICK_CHAT } from '../shared/chat';
import { parseClientMessage } from '../shared/protocol';

describe('installable app', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));

  it('has a manifest that opens full screen in landscape', () => {
    expect(manifest).toMatchObject({ name: 'Rooftop Rush', start_url: '/', display: 'fullscreen', orientation: 'landscape' });
  });

  it('has every icon it lists, including one Android can crop', () => {
    for (const icon of manifest.icons) expect(existsSync(`public${icon.src}`), icon.src).toBe(true);
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
    for (const f of ['apple-touch-icon.png', 'favicon-32.png']) expect(existsSync(`public/icons/${f}`)).toBe(true);
  });

  it('is linked from the page', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it('has a service worker that leaves the game server and other sites alone', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain("url.origin !== self.location.origin");
    expect(sw).toContain("req.method !== 'GET'");
  });
});

describe('vibration', () => {
  it('does nothing on devices without it, or when switched off', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    new Haptics(false).buzz(BUZZ.shot); // not a touch device
    const h = new Haptics(true);
    h.enabled = false;
    h.buzz(BUZZ.shot);
    expect(vibrate).not.toHaveBeenCalled();
    h.enabled = true;
    h.buzz(BUZZ.tackle);
    expect(vibrate).toHaveBeenCalledWith(BUZZ.tackle);
    vi.unstubAllGlobals();
  });

  it('keeps every buzz short', () => {
    for (const p of Object.values(BUZZ)) {
      const total = typeof p === 'number' ? p : p.reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(400);
    }
  });

  it('is on by default', () => {
    expect(loadSettings().vibration).toBe(true);
  });
});

describe('quick chat', () => {
  it('only accepts messages from the list', () => {
    expect(QUICK_CHAT.length).toBeGreaterThan(0);
    expect(isChatId(0)).toBe(true);
    expect(isChatId(QUICK_CHAT.length - 1)).toBe(true);
    for (const bad of [-1, QUICK_CHAT.length, 1.5, '1', null]) expect(isChatId(bad)).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'chat', id: 2 }))).toEqual({ t: 'chat', id: 2 });
    expect(parseClientMessage(JSON.stringify({ t: 'chat', id: 2, text: 'anything I like' }))).toEqual({ t: 'chat', id: 2 });
    expect(parseClientMessage(JSON.stringify({ t: 'chat', id: 'hello' }))).toBeNull();
  });

  it('has a cooldown, so nobody can flood the room', () => {
    expect(CHAT_COOLDOWN_MS).toBeGreaterThanOrEqual(500);
  });
});
