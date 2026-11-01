import { describe, expect, it } from 'vitest';
import { cleanTeamName, MAX_TEAM_NAME, teamNames } from '../shared/names';
import { parseClientMessage } from '../shared/protocol';

describe('team names', () => {
  it('tidies up what people type', () => {
    expect(cleanTeamName('  red   lions ', 'X')).toBe('RED LIONS');
    expect(cleanTeamName('fc-united_99', 'X')).toBe('FC-UNITED_99');
    expect(cleanTeamName("o'brien fc", 'X')).toBe("O'BRIEN FC");
  });

  it('keeps letters from any language', () => {
    expect(cleanTeamName('Al Nasr نصر', 'X')).toBe('AL NASR نصر');
    expect(cleanTeamName('Ñandú', 'X')).toBe('ÑANDÚ');
  });

  it('strips markup, emoji and other symbols', () => {
    expect(cleanTeamName('<b>Kings</b>', 'X')).toBe('BKINGSB');
    expect(cleanTeamName('Rockets 🚀🚀', 'X')).toBe('ROCKETS');
    expect(cleanTeamName('a\u0000b\nc', 'X')).toBe('ABC');
  });

  it(`caps the length at ${MAX_TEAM_NAME} characters`, () => {
    expect(cleanTeamName('Supercalifragilistic', 'X')).toHaveLength(MAX_TEAM_NAME);
  });

  it('falls back to the default for empty, too-short or non-text names', () => {
    expect(cleanTeamName('', 'SKYLINE')).toBe('SKYLINE');
    expect(cleanTeamName('   ', 'SKYLINE')).toBe('SKYLINE');
    expect(cleanTeamName('!', 'SKYLINE')).toBe('SKYLINE');
    expect(cleanTeamName(42, 'SKYLINE')).toBe('SKYLINE');
    expect(cleanTeamName(undefined, 'NEON')).toBe('NEON');
  });

  it('gives each side its own name, even when both pick the same one', () => {
    expect(teamNames('Lions', undefined)).toEqual(['LIONS', 'NEON']);
    expect(teamNames(undefined, 'Tigers')).toEqual(['SKYLINE', 'TIGERS']);
    expect(teamNames('Neon', undefined)).toEqual(['NEON', 'SKYLINE']);
    const [a, b] = teamNames('Lions', 'lions');
    expect(a).toBe('LIONS');
    expect(b).not.toBe(a);
  });

  it('travels with online messages, and long junk is cut short before it reaches the server', () => {
    expect(parseClientMessage('{"t":"create","name":"Lions"}')).toEqual({ t: 'create', name: 'Lions' });
    expect(parseClientMessage('{"t":"join","code":"ABCD","name":"Lions"}')).toEqual({ t: 'join', code: 'ABCD', name: 'Lions' });
    expect(parseClientMessage('{"t":"quick"}')).toEqual({ t: 'quick' });
    const long = parseClientMessage(JSON.stringify({ t: 'quick', name: 'x'.repeat(300) }));
    expect(long && 'name' in long && long.name?.length).toBe(64);
  });
});
