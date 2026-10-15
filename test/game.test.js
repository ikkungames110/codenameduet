import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKey, newGame, apply, greensLeft, viewFor } from '../src/game.js';
import { WORDS } from '../src/words.js';

test('キーカードの分布が公式どおり', () => {
  const k = makeKey();
  for (const s of ['A', 'B']) {
    assert.equal(k[s].filter((v) => v === 'g').length, 9);
    assert.equal(k[s].filter((v) => v === 'a').length, 3);
  }
  assert.equal(k.A.filter((v, i) => v === 'g' && k.B[i] === 'g').length, 3);
});

test('緑→継続、一般人→交代とタイマー減少、暗殺者→敗北', () => {
  let s = newGame({ words: WORDS.ja, names: { A: 'a', B: 'b' }, settings: { firstGiver: 'A' } });
  s = apply(s, 'A', { type: 'clue', word: 'てすと', num: '2' });
  const g = s.key.A.indexOf('g');
  s = apply(s, 'B', { type: 'guess', idx: g });
  assert.equal(s.phase, 'guess');
  assert.equal(greensLeft(s, 'A'), 8);
  const n = s.key.A.indexOf('n');
  s = apply(s, 'B', { type: 'guess', idx: n });
  assert.equal(s.phase, 'clue');
  assert.equal(s.giver, 'B');
  assert.equal(s.timer, 8);
  assert.ok(viewFor(s, 'B').key.A === undefined);
  s = apply(s, 'B', { type: 'clue', word: 'x', num: '1' });
  s = apply(s, 'A', { type: 'guess', idx: s.key.B.indexOf('a') });
  assert.equal(s.phase, 'lost');
});
