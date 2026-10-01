'use strict';
const test = require('node:test'), assert = require('node:assert');
const {createTable, s5, best, category} = require('../engine');

// cards: rank index c%13 (0='2' .. 12='A'), suit c/13 (0..3)
const card = (r, s) => '23456789TJQKA'.indexOf(r) + 13 * s;
const E = Array(12).fill('');
function clock(t = 1e6) { const c = () => c.t; c.t = t; return c }
// Pat all-in on the river with 7-2 against Host's aces; Host to call 100
const river = () => ({players: {Host: {chips: 900}, Pat: {chips: 0}}, seats: ['Host', 'Pat', ...E.slice(2)], pend: {}, leave: {}, bust: {}, buy: {}, wait: 0,
  btn: 0, sb: 5, bb: 10, game: 'holdem', n: 1, last: 1,
  hand: {ps: [1, 0], btn: 0, d: [], board: [card('2', 0), card('9', 1), card('J', 2), card('K', 3), card('4', 1)],
    h: {0: [card('A', 0), card('A', 1)], 1: [card('7', 0), card('2', 1)]},
    bet: {0: 0, 1: 100}, tot: {0: 100, 1: 200}, fold: {}, allin: {1: 1}, acted: {1: 1}, stage: 3, cur: 100, minR: 10, turn: 0, done: 0, show: 0, msg: ''}});

test('hand ranking', () => {
  const h = s => s.split(' ').map(x => card(x[0], 'shdc'.indexOf(x[1])));
  assert.equal(category(s5(h('Ah 2s 3d 4c 5h'))), 'Straight');            // wheel
  assert.ok(s5(h('6h 2s 3d 4c 5h')) > s5(h('Ah 2s 3d 4c 5h')));            // six-high beats wheel
  assert.ok(s5(h('2h 7h 9h Jh Kh')) > s5(h('Th Js Qd Kc Ah')));            // flush > straight
  assert.ok(s5(h('Ts Js Qs Ks As')) > s5(h('9h 9s 9d 9c Ah')));            // straight flush > quads
  assert.ok(s5(h('Ah Ad Kc Ks 2h')) > s5(h('Ah Ad Qc Qs Kh')));            // two pair kicker order
  assert.equal(category(best(h('Ah Ad As Kc Kd 2h 3s'))), 'Full house');
});

test('a player sees only their own hole cards, never the deck', () => {
  const t = createTable(river());
  const v = t.view('Pat');
  assert.equal(v.hand.d, undefined);
  assert.deepEqual(v.hand.h[1], river().hand.h[1]);
  assert.deepEqual(v.hand.h[0], [null, null]);
  assert.deepEqual(t.view('').hand.h[1], [null, null]);
  assert.ok(!JSON.stringify(v).includes('"d"'));
});

test('showdown reveals live hands, pays the winner, and the 10s pause holds the next deal', () => {
  const c = clock(), t = createTable(river(), {now: c});
  t.player('Host', {t: 'act', a: 'call'});
  const s = t.state(), v = t.view('Pat');
  assert.equal(s.hand.done, 1);
  assert.equal(s.players.Host.chips, 1200);
  assert.deepEqual(v.hand.h[0], river().hand.h[0]);
  assert.match(s.hand.msg, /Host wins 400 \(Pair\)/);
  t.host({op: 'bot'});
  assert.match(t.host({op: 'start'}), /Waiting on Pat/);
});

test('busted player: 30s to choose, deal held, then stood up automatically', () => {
  const c = clock(), t = createTable(river(), {now: c});
  t.player('Host', {t: 'act', a: 'call'}); t.host({op: 'bot'});
  assert.equal(t.state().bust.Pat, c.t + 30000);
  c.t += 29000; t.tick();
  assert.ok(t.state().seats.includes('Pat'));
  assert.match(t.host({op: 'start'}), /Waiting on Pat/);
  c.t += 1001; t.tick();
  assert.ok(!t.state().seats.includes('Pat'));
  assert.equal(t.host({op: 'start'}), undefined);
  assert.ok(t.state().hand && !t.state().hand.done);
});

test('busted player asks for chips; host gives them; deal unblocks', () => {
  const c = clock(), t = createTable(river(), {now: c});
  t.player('Host', {t: 'act', a: 'call'});
  t.player('Pat', {t: 'buy'});
  assert.ok(!t.state().bust.Pat && t.state().buy.Pat);
  c.t += 60000; t.tick();
  assert.ok(t.state().seats.includes('Pat'), 'choosing stops the 30s timer');
  assert.match(t.host({op: 'start'}), /Waiting on Pat/);
  t.host({op: 'give', name: 'Pat', add: 500});
  assert.equal(t.state().players.Pat.chips, 500);
  assert.equal(t.host({op: 'start'}), undefined);
});

test('standing up mid-hand folds at your turn and frees the seat when the hand ends', () => {
  const s = river(); s.players.Pat.chips = 500; s.hand.allin = {}; s.hand.turn = 1; s.hand.acted = {0: 1}; s.hand.bet = {0: 100, 1: 0};
  const t = createTable(s);
  t.player('Pat', {t: 'stand'});
  const st = t.state();
  assert.equal(st.hand.fold[1], 1);
  assert.equal(st.hand.done, 1);
  assert.ok(!st.seats.includes('Pat'));
  assert.equal(st.players.Pat.chips, 500, 'chips stay saved by name');
});

test('only the player whose turn it is can act; seat requests need the host', () => {
  const t = createTable(river());
  assert.equal(t.player('Pat', {t: 'act', a: 'fold'}), 'Not your turn');
  t.player('Zed', {t: 'sit'});
  assert.ok(t.state().pend.Zed && !t.state().seats.includes('Zed'));
  t.host({op: 'seat', name: 'Zed'});
  assert.equal(t.state().players.Zed.chips, 1000);
  assert.ok(t.state().seats.includes('Zed'));
});

test('bots play hundreds of hands without creating or losing chips', () => {
  let hands = 0;
  for (let table = 1; table <= 25; table++) {
    const c = clock(); let seed = table * 7919; const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const t = createTable(null, {now: c, random, shuffle: () => { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = random() * (i + 1) | 0; [d[i], d[j]] = [d[j], d[i]] } return d }});
    for (let i = 0; i < 6; i++) t.host({op: 'bot'});
    const total = () => Object.values(t.state().players).reduce((a, p) => a + p.chips, 0) + (t.state().hand && !t.state().hand.done ? Object.values(t.state().hand.tot).reduce((a, b) => a + b, 0) : 0);
    while (!t.host({op: 'start'})) {
      hands++;
      for (let g = 0; g < 500 && !t.state().hand.done; g++) { c.t += 1500; t.tick(); assert.equal(total(), 6000) }
      assert.equal(t.state().hand.done, 1, 'hand finished');
      c.t += 10000; t.tick();
    }
    assert.equal(total(), 6000);
  }
  assert.ok(hands > 200, 'played ' + hands + ' hands');
});
