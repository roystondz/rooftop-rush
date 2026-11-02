import { describe, expect, it } from 'vitest';
import { applySnapshot, lerpSnapshots, makeSnapshot, packInput, parseClientMessage, unpackInput } from '../shared/protocol';
import { createWorld } from '../shared/sim';

describe('inputs', () => {
  it('survive packing and unpacking', () => {
    const input = { moveX: 0.707, moveZ: -1, sprint: true, shoot: false, pass: true, tackle: false, through: true, skill: true, lob: true };
    expect(unpackInput(packInput(input))).toEqual({ ...input, moveX: 0.71 });
  });

  it('are clamped, so a client cannot run faster by sending huge numbers', () => {
    expect(unpackInput([50, -50, 0])).toMatchObject({ moveX: 1, moveZ: -1 });
  });
});

describe('parseClientMessage', () => {
  it('accepts valid messages', () => {
    expect(parseClientMessage('{"t":"quick"}')).toEqual({ t: 'quick' });
    expect(parseClientMessage('{"t":"join","code":"abcd"}')).toEqual({ t: 'join', code: 'ABCD' });
    expect(parseClientMessage('{"t":"input","seq":3,"i":[0.5,0,6]}')).toEqual({ t: 'input', seq: 3, i: [0.5, 0, 6] });
  });

  it('rejects junk and tampered messages', () => {
    for (const bad of [
      'not json',
      'null',
      '{"t":"teleport"}',
      '{"t":"join","code":"AB"}',
      '{"t":"join","code":"ABCD; DROP"}',
      '{"t":"input","seq":1,"i":[0,0]}',
      '{"t":"input","seq":1,"i":[0,0,128]}',
      '{"t":"input","seq":1,"i":[0,0,1.5]}',
      '{"t":"input","seq":"1","i":[0,0,0]}',
      '{"t":"input","seq":1,"i":["a",0,0]}',
      'x'.repeat(1000),
    ]) {
      expect(parseClientMessage(bad), bad.slice(0, 40)).toBeNull();
    }
  });
});

describe('snapshots', () => {
  it('carry the world across and back', () => {
    const w = createWorld();
    w.players[2].x = 7.25;
    w.players[2].charging = true;
    w.ball.owner = 4;
    w.score = [2, 1];
    const copy = createWorld();
    applySnapshot(copy, JSON.parse(JSON.stringify(makeSnapshot(w, [0, 3], []))));
    expect(copy.players[2].x).toBe(7.25);
    expect(copy.players[2].charging).toBe(true);
    expect(copy.ball.owner).toBe(4);
    expect(copy.score).toEqual([2, 1]);
  });

  it('blend positions between two snapshots', () => {
    const w = createWorld();
    w.players[0].x = 0;
    const a = makeSnapshot(w, [0, 3], []);
    w.players[0].x = 10;
    w.tick += 2;
    const b = makeSnapshot(w, [0, 3], []);
    const view = createWorld();
    lerpSnapshots(view, a, b, 0.25);
    expect(view.players[0].x).toBeCloseTo(2.5);
  });
});
