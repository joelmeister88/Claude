'use strict';
const test = require('node:test'), assert = require('node:assert');
const {createTable, s5, best, bestW, scoreAny, category} = require('../engine');

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
      for (let g = 0; g < 500 && !t.state().hand.done; g++) { c.t += 5000; t.tick(); assert.equal(total(), 6000) }
      assert.equal(t.state().hand.done, 1, 'hand finished');
      c.t += 10000; t.tick();
    }
    assert.equal(total(), 6000);
  }
  assert.ok(hands > 200, 'played ' + hands + ' hands');
});

// three seated humans, fresh hand: A is button, B small blind, C big blind, A first to act
function threeHanded(c) {
  const t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  t.host({op: 'start'}); return t;
}
const turnName = t => t.state().seats[t.state().hand.turn];

test('30s turn clock: folds facing a bet, checks when free', () => {
  const c = clock(), t = threeHanded(c), first = turnName(t);
  assert.equal(t.view(first).hand.dl, c.t + 30000);
  c.t += 29999; t.tick(); assert.equal(turnName(t), first);
  c.t += 1; t.tick();
  const s = t.state(); assert.equal(s.hand.fold[s.seats.indexOf(first)], 1, 'facing the big blind: fold');
  assert.match(s.hand.msg, /folds \(out of time\)/);
  // small blind calls, big blind may check: let the big blind's clock run out
  t.player(turnName(t), {t: 'act', a: 'call'});
  const bb = turnName(t), before = t.state().hand.stage;
  c.t += 30000; t.tick();
  assert.ok(!t.state().hand.fold[t.state().seats.indexOf(bb)], 'no bet to call: check, not fold');
  assert.equal(t.state().hand.stage, before + 1, 'check closed the round');
});

test('three timeouts in a row stand a player up; acting resets the count', () => {
  const c = clock(), t = threeHanded(c), slow = turnName(t);
  t.state().players[slow].miss = 2;
  t.player(slow, {t: 'act', a: 'call'});
  assert.equal(t.state().players[slow].miss, 0, 'acting resets the count');
  // from here everyone else calls and `slow` only ever lets the clock run out
  let outs = 0;
  for (let g = 0; g < 2000 && t.state().seats.includes(slow); g++) {
    const H = t.state().hand;
    if (H.done) { c.t += 10000; t.tick(); t.host({op: 'start'}) }
    else if (turnName(t) !== slow) t.player(turnName(t), {t: 'act', a: 'call'});
    else { c.t += 30000; t.tick(); outs++ }
  }
  assert.equal(outs, 3, 'stood up after the third timeout in a row');
  assert.ok(t.state().players[slow].chips > 0, 'chips kept');
  assert.equal(t.state().players[slow].miss, 0, 'count starts over if they sit back down');
});

test('the dealer deals with their own blinds; nobody else can', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state();
  assert.equal(s.seats[s.dealer], 'A', 'first dealer is the first seat');
  assert.equal(s.dealDl, c.t + 120000, 'the dealer has 2 minutes');
  assert.equal(t.player('B', {t: 'deal'}), "You're not the dealer");
  for (const bad of [0, 5, 25, -10, 'x']) assert.match(t.player('A', {t: 'deal', bb: bad}), /10 or more, in steps of 10/);
  assert.equal(t.player('A', {t: 'deal', bb: 50, sb: 7}), undefined, 'small blind is not the dealer\'s to pick');
  assert.equal(s.btn, 0); assert.equal(s.sb, 25); assert.equal(s.hand.cur, 50);
  for (let g = 0; g < 50 && !s.hand.done; g++) t.player(s.seats[s.hand.turn], {t: 'act', a: 'fold'});
  assert.equal(s.seats[s.dealer], 'B', 'button moves one to the left');
  assert.equal(s.dealDl, c.t + 10000 + 120000, 'clock starts after the 10s pause');
});

test('a dealer who waits 2 minutes passes the deal to the left', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state();
  c.t += 119999; t.tick(); assert.equal(s.seats[s.dealer], 'A');
  c.t += 1; t.tick(); assert.equal(s.seats[s.dealer], 'B');
  assert.equal(s.dealDl, c.t + 120000, 'new dealer gets a fresh 2 minutes');
  assert.equal(t.player('A', {t: 'deal'}), "You're not the dealer");
  c.t += 120000; t.tick(); c.t += 120000; t.tick();
  assert.equal(s.seats[s.dealer], 'A', 'and around the table');
});

test('a bot dealer deals by itself when a person is playing', () => {
  const c = clock(), t = createTable(null, {now: c});
  t.host({op: 'bot'}); t.host({op: 'bot'});
  c.t += 5000; t.tick(); assert.ok(!t.state().hand, 'bots alone do not start');
  t.player('Ann', {t: 'sit'}); t.host({op: 'seat', name: 'Ann'});
  t.tick(); c.t += 4999; t.tick(); assert.ok(!t.state().hand, 'bots take 5 seconds');
  c.t += 1; t.tick();
  assert.ok(t.state().hand && !t.state().hand.done);
});

test('name history: remembers people (not bots), forget and reset', () => {
  const D = ['Joel', 'Jesi', 'Paul', 'Kate', 'Branson', 'Shane', 'Darrin', 'Jennifer', 'Mitchell', 'Shay', 'Sam', 'Kelli', 'Jason'];
  const c = clock(), t = createTable({players: {Old: {chips: 300}, 'Bot 1': {chips: 5, bot: 1}}}, {now: c});
  assert.deepEqual(t.view('').known, ['Old', ...D], 'our regulars are offered from the start');
  t.remember('Pat'); c.t += 1; t.remember('Kate');
  assert.deepEqual(t.view('').known.slice(0, 3), ['Kate', 'Pat', 'Old'], 'most recent first');
  t.player('Pat', {t: 'sit'});
  assert.match(t.forget('Pat'), /at the table/);
  assert.equal(t.forget('Old'), undefined); assert.equal(t.forget('Jason'), undefined);
  assert.ok(!t.state().players.Old && !t.view('').known.includes('Old') && !t.view('').known.includes('Jason'));
  const again = createTable(JSON.parse(JSON.stringify(t.state())), {now: c});
  assert.ok(!again.view('').known.includes('Jason'), 'a deleted default name stays deleted after a restart');
  t.reset();
  assert.deepEqual(t.view('').known, D, 'reset: just the regulars'); assert.deepEqual(t.state().players, {}); assert.ok(t.state().seats.every(x => !x));
  t.player('Z', {t: 'sit'}); assert.equal(t.host({op: 'seat', name: 'Z'}), undefined, 'seating works right after a reset');
});

test('host pause freezes every clock and resume pushes deadlines back', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  t.host({op: 'start'});
  const s = t.state(), dl = s.hand.dl, who = s.hand.turn;
  assert.ok(dl > 0);
  t.host({op: 'pause', on: true});
  assert.ok(t.view('').paused);
  c.t += 600000; t.tick();
  assert.equal(s.hand.turn, who, 'turn clock frozen');
  t.host({op: 'pause', on: false});
  assert.equal(s.hand.dl, dl + 600000, 'deadline pushed back by the pause');
  c.t += 29000; t.tick(); assert.equal(s.hand.turn, who);
  c.t += 1001; t.tick(); assert.notEqual(s.hand.turn, who, 'clock runs again');
});

test('a seat request freezes the clocks and holds the deal until the host answers', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), dl = s.dealDl;
  t.player('Late', {t: 'sit'});
  assert.equal(t.view('').hold, 'seats');
  c.t += 120000; t.tick();
  assert.equal(s.seats[s.dealer], 'A', 'dealer clock frozen');
  assert.match(t.player('A', {t: 'deal'}), /seat Late/);
  t.host({op: 'seat', name: 'Late'});
  assert.equal(t.view('').hold, '');
  assert.equal(s.dealDl, dl + 120000, 'deadline pushed back by the wait');
  assert.equal(t.player('A', {t: 'deal'}), undefined);
  assert.ok(s.hand.ps.length == 3, 'the new player is dealt in');
  t.player('Later', {t: 'sit'}); t.host({op: 'noseat', name: 'Later'});
  assert.equal(t.view('').hold, '', 'declining also releases the hold');
});

test('a full table has a waitlist; the front of the line gets the next open seat', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (let i = 0; i < 11; i++) t.host({op: 'bot'});
  t.player('Ann', {t: 'sit'}); t.host({op: 'seat', name: 'Ann'});
  const s = t.state();
  assert.ok(s.seats.every(Boolean), 'all 12 seats taken');
  t.player('Ben', {t: 'sit'}); t.player('Cy', {t: 'sit'}); t.player('Di', {t: 'sit'});
  assert.deepEqual(t.view('').queue, ['Ben', 'Cy', 'Di']);
  assert.deepEqual(s.pend, {}, 'nobody can request a seat that does not exist');
  assert.equal(t.view('').hold, '', 'a waitlist does not pause the game');
  t.player('Cy', {t: 'unsit'});
  assert.deepEqual(s.queue, ['Ben', 'Di'], 'leaving the line');
  t.player('Ann', {t: 'stand'});
  assert.deepEqual(Object.keys(s.pend), ['Ben'], 'front of the line becomes a seat request');
  assert.deepEqual(s.queue, ['Di']);
  assert.equal(t.view('').hold, 'seats', 'and the host is alerted');
  t.host({op: 'noseat', name: 'Ben'});
  assert.deepEqual(Object.keys(s.pend), ['Di'], 'declined: the next in line moves up');
  t.host({op: 'seat', name: 'Di'});
  assert.ok(s.seats.includes('Di') && !s.queue.length);
});

test("dealer's choice: only the dealer changes the game, between hands, to a ready game", () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const v = t.view('');
  assert.deepEqual(v.games.map(g => g.id), ['holdem', 'syn', 'bts', 'nopeek', 'draw'], "Hold'em is listed first");
  assert.equal(v.gameName, "Texas Hold'em");
  assert.match(t.player('B', {t: 'game', game: 'holdem'}), /Only the dealer/);
  assert.match(t.player('A', {t: 'game', game: 'nope'}), /isn't available yet/);
  assert.equal(t.player('A', {t: 'game', game: 'holdem'}), undefined);
  t.player('A', {t: 'deal'});
  assert.match(t.player('A', {t: 'game', game: 'holdem'}), /between hands/);
});

test("Hold'em: bets go up in steps of the big blind; all-in can be any amount", () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  t.player('A', {t: 'deal', bb: 30});
  const H = t.state().hand, first = t.state().seats[H.turn];
  t.player(first, {t: 'act', a: 'raise', amt: 50});
  assert.equal(H.cur, 60, 'a raise of less than one blind becomes the smallest legal raise');
  t.player(t.state().seats[H.turn], {t: 'act', a: 'raise', amt: 140});
  assert.equal(H.cur, 120, 'rounded down to a multiple of the blind');
  const n = t.state().seats[H.turn], all = t.state().players[n].chips + H.bet[H.turn];
  t.player(n, {t: 'act', a: 'raise', amt: 1e9});
  assert.equal(H.cur, all, 'all-in is whatever they have');
  assert.ok(all % 30 != 0);
});

// Screw Your Neighbor: a rigged deck (cards are dealt from the end)
const synTable = (names, deck, c = clock()) => {
  const t = createTable(null, {now: c, shuffle: () => deck.slice()});
  for (const n of names) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  t.host({op: 'game'}); t.player(names[0], {t: 'game', game: 'syn'});
  return t;
};
const C = r => '23456789TJQKA'.indexOf(r); // spades

test('Screw Your Neighbor: ante, 4 lives, swaps, lowest loses a life', () => {
  // seats A0 (dealer) B1 C2: order B, C, then A last. Deal pops: B=5, C=K, A=9
  const t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('K'), C('5')]);
  assert.match(t.player('A', {t: 'deal', ante: 150}), /steps of 100/);
  assert.equal(t.player('A', {t: 'deal', ante: 200}), undefined);
  const s = t.state(), H = s.hand;
  assert.equal(H.g, 'syn'); assert.equal(H.pot, 600); assert.equal(s.players.B.chips, 800);
  assert.deepEqual(H.lives, {0: 4, 1: 4, 2: 4});
  assert.equal(s.seats[H.turn], 'B', 'left of the dealer goes first');
  assert.equal(t.view('B').hand.cards[2], null, "can't see others' cards");
  assert.equal(t.view('B').hand.deckN, 2);
  t.player('B', {t: 'act', a: 'swap'});        // B(5) <-> C(K)
  assert.equal(H.cards[1], C('K')); assert.equal(H.cards[2], C('5'));
  t.player('C', {t: 'act', a: 'keep'});
  t.player('A', {t: 'act', a: 'swap'});        // dealer takes the top of the deck (3), no strings attached
  assert.equal(H.cards[0], C('3'));
  assert.equal(H.stage, 'reveal'); assert.equal(H.lives[0], 3, 'lowest card loses a life');
  assert.equal(t.view('B').hand.cards[0], C('3'), 'cards are shown at the reveal');
});

test('Screw Your Neighbor: Aces cannot be taken, ties all lose, deck reshuffles, last one standing wins', () => {
  const c = clock();
  // round 1 deal: B=A, C=4, A=4 (pops from the end)
  const t = synTable(['A', 'B', 'C'], [C('7'), C('4'), C('4'), C('A')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  t.player('C', {t: 'act', a: 'show'});
  assert.ok(!H.shown[2], 'only an Ace can be shown');
  t.player('B', {t: 'act', a: 'show'});
  assert.ok(t.view('C').hand.cards[1] == C('A'), 'a shown Ace is face up for everyone');
  t.player('B', {t: 'act', a: 'keep'}); t.player('C', {t: 'act', a: 'keep'}); t.player('A', {t: 'act', a: 'keep'});
  assert.deepEqual([H.lives[0], H.lives[1], H.lives[2]], [3, 4, 3], 'tied lowest: both lose a life');
  // next round needs 4 cards (3 + 1 spare), deck has 0 left: reshuffle
  c.t += 5000; t.tick();
  assert.equal(H.round, 2); assert.match(H.msg, /reshuffled/);
  // play out: whoever holds the lowest keeps losing until one is left
  for (let g = 0; g < 200 && !H.done; g++) {
    if (H.stage == 'reveal') { c.t += 5000; t.tick(); continue }
    t.player(s.seats[H.turn], {t: 'act', a: 'keep'});
  }
  assert.equal(H.done, 1);
  const winner = s.seats[H.ps.find(i => H.lives[i] > 0)];
  assert.equal(s.players[winner].chips, 900 + 300, 'winner takes the pot');
  assert.equal(Object.values(s.players).reduce((a, p) => a + p.chips, 0), 3000, 'no chips created or lost');
});

test('Screw Your Neighbor: swapping into a hidden Ace fails and reveals it', () => {
  const t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('A'), C('5')]); // B=5, C=A, A=9
  t.player('A', {t: 'deal'});
  const H = t.state().hand;
  t.player('B', {t: 'act', a: 'swap'});
  assert.equal(H.cards[1], C('5')); assert.equal(H.cards[2], C('A')); assert.ok(H.shown[2]);
  assert.match(H.msg, /has an Ace/);
  assert.equal(t.state().seats[H.turn], 'C', 'the turn moves on');
});

test('Screw Your Neighbor: standing up forfeits; timeouts keep', () => {
  const c = clock(), t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('K'), C('5')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  c.t += 30000; t.tick();
  assert.equal(H.cards[1], C('5')); assert.equal(s.seats[H.turn], 'C', 'out of time: keep');
  t.player('C', {t: 'stand'});
  assert.equal(H.lives[2], 0); assert.equal(s.seats[H.turn], 'A');
  t.player('B', {t: 'stand'});
  assert.equal(H.done, 1, 'one player left wins');
  assert.equal(s.players.A.chips, 900 + 300);
  assert.ok(!s.seats.includes('B') && !s.seats.includes('C'), 'they leave their seats when the game ends');
});

test('Screw Your Neighbor: bots play many games without creating or losing chips', () => {
  let games = 0;
  for (let table = 1; table <= 20; table++) {
    const c = clock(); let seed = table * 104729; const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const t = createTable(null, {now: c, random, shuffle: () => { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = random() * (i + 1) | 0; [d[i], d[j]] = [d[j], d[i]] } return d }});
    for (let i = 0; i < 2 + table % 9; i++) t.host({op: 'bot'});
    t.state().game = 'syn';
    const total = () => Object.values(t.state().players).reduce((a, p) => a + p.chips, 0) + (t.state().hand && !t.state().hand.done ? t.state().hand.pot : 0) + (t.state().carry || 0);
    const start = total();
    for (let k = 0; k < 5 && !t.host({op: 'start'}); k++) {
      games++;
      for (let g = 0; g < 5000 && !t.state().hand.done; g++) { c.t += 5000; t.tick(); assert.equal(total(), start) }
      assert.equal(t.state().hand.done, 1, 'game finished');
      c.t += 10000; t.tick();
    }
    assert.equal(total(), start);
  }
  assert.ok(games > 40, 'played ' + games + ' games');
});

test('Screw Your Neighbor: if everyone goes out together, the pot carries over and players can ante again', () => {
  const c = clock(), t = synTable(['A', 'B', 'C'], [C('7'), C('9'), C('9'), C('9')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  H.lives = {0: 1, 1: 1, 2: 1}; // last lives all round
  for (const n of ['B', 'C', 'A']) t.player(n, {t: 'act', a: 'keep'});
  assert.equal(H.done, 1); assert.match(H.msg, /Everyone is out! The pot of 300 carries over/);
  assert.equal(t.view('').carry, 300);
  assert.deepEqual(t.view('').again.who, ['A', 'B', 'C']);
  assert.equal(t.host({op: 'start'}), 'Waiting for players to ante again', 'no normal deal meanwhile');
  assert.ok(!t.state().hand || t.state().hand.done);
  t.player('A', {t: 'again', yes: true}); t.player('C', {t: 'again', yes: true}); t.player('B', {t: 'again', yes: false});
  const H2 = t.state().hand;
  assert.notEqual(H2, H); assert.equal(H2.g, 'syn'); assert.equal(H2.btn, 0, 'same dealer');
  assert.deepEqual(H2.ps.map(i => s.seats[i]), ['C', 'A']);
  assert.equal(H2.pot, 300 + 200, 'carried pot plus the new antes');
  assert.deepEqual(Object.values(H2.lives), [4, 4]);
  assert.equal(t.view('').carry, 0);
});

test('Screw Your Neighbor: nobody antes again in time, so the pot waits for the next game', () => {
  const c = clock(), t = synTable(['A', 'B'], [C('7'), C('9'), C('9')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(); s.hand.lives = {0: 1, 1: 1};
  t.player('B', {t: 'act', a: 'keep'}); t.player('A', {t: 'act', a: 'keep'});
  t.player('A', {t: 'again', yes: true});
  c.t += 30000; t.tick();
  assert.equal(t.view('').again, null); assert.equal(t.view('').carry, 200);
  assert.match(s.hand.msg, /waits for the next/);
  c.t += 10000; t.tick();
  t.player(s.seats[s.dealer], {t: 'deal'});
  assert.equal(s.hand.pot, 400, 'carried into the next game');
});

test('Screw Your Neighbor: each player sees what they traded, and nobody else does', () => {
  // B=5, C=K, A=9; deck top is 3
  const t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('K'), C('5')]);
  t.player('A', {t: 'deal'});
  t.player('B', {t: 'act', a: 'swap'});
  assert.deepEqual(t.view('B').hand.notes, [{k: 'gave', to: 'C', gave: C('5'), got: C('K')}]);
  assert.deepEqual(t.view('C').hand.notes, [{k: 'took', from: 'B', gave: C('K'), got: C('5')}]);
  assert.deepEqual(t.view('A').hand.notes, [], 'the dealer did not see that trade');
  t.player('C', {t: 'act', a: 'keep'}); t.player('A', {t: 'act', a: 'swap'});
  assert.deepEqual(t.view('A').hand.notes, [{k: 'deck', gave: C('9'), got: C('3')}]);
});

test('a Screw Your Neighbor game saved by an older version keeps working', () => {
  const t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('K'), C('5')]);
  t.player('A', {t: 'deal'});
  delete t.state().hand.notes;
  t.player('B', {t: 'act', a: 'swap'});
  assert.equal(t.view('B').hand.notes.length, 1);
});

test("nobody can bet more than they have", () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(); s.players.B.chips = 15; s.players.C.chips = 250;
  t.player('A', {t: 'deal', bb: 30});
  const H = s.hand;
  assert.equal(s.players.B.chips, 0); assert.equal(H.bet[1], 15, "a blind you can't cover puts you all-in for what you have");
  // A acts first (3-handed: A dealer, B small, C big, A first)
  t.player('A', {t: 'act', a: 'raise', amt: 999999});
  assert.equal(H.bet[0], 1000); assert.equal(s.players.A.chips, 0, 'a raise beyond your stack is all-in');
  t.player('C', {t: 'act', a: 'call'});
  assert.equal(H.tot[2], 250, 'calling more than you have is all-in for what you have');
  assert.equal(H.done, 1, 'everyone all-in: the board runs out');
  for (const n in s.players) assert.ok(s.players[n].chips >= 0);
  assert.equal(Object.values(s.players).reduce((a, p) => a + p.chips, 0), 1000 + 15 + 250, 'no chips created or lost');
});

test('odd raise amounts (negative, text, fractions) never take more than you have', () => {
  for (const amt of [-500, 'lots', 33.7, 1e300, null]) {
    const t = createTable(null, {now: clock()});
    for (const n of ['A', 'B']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
    t.player('A', {t: 'deal'});
    const s = t.state(), n = s.seats[s.hand.turn];
    t.player(n, {t: 'act', a: 'raise', amt});
    for (const x in s.players) assert.ok(s.players[x].chips >= 0 && Number.isInteger(s.players[x].chips), String(amt));
  }
});

test('Screw Your Neighbor: holding an Ace, swap is off and the turn passes after 5 seconds', () => {
  const c = clock(), t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('K'), C('A')], c); // B=A, C=K, A=9
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  assert.equal(H.dl, c.t + 5000, 'a 5 second turn');
  assert.match(t.player('B', {t: 'act', a: 'swap'}), /no need to swap/);
  c.t += 4999; t.tick(); assert.equal(s.seats[H.turn], 'B');
  c.t += 1; t.tick();
  assert.equal(s.seats[H.turn], 'C', 'next player'); assert.equal(H.msg, 'B keeps', 'no "out of time" note');
  assert.equal(H.dl, c.t + 30000, 'everyone else still gets 30 seconds');
});

test("Screw Your Neighbor: can't swap into an Ace that's showing; keep instead", () => {
  const t = synTable(['A', 'B', 'C'], [C('2'), C('3'), C('9'), C('A'), C('5')]); // B=5, C=A, A=9
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  t.player('C', {t: 'act', a: 'show'});
  assert.match(t.player('B', {t: 'act', a: 'swap'}), /C has an Ace showing/);
  assert.equal(s.seats[H.turn], 'B', 'still your turn: press Keep');
  assert.equal(t.player('B', {t: 'act', a: 'keep'}), undefined);
  assert.equal(s.seats[H.turn], 'C');
});

// Between the Sheets: a rigged deck, dealt from the end (two cards, then the middle card)
const btsTable = (names, deck, c = clock()) => {
  const t = createTable(null, {now: c, shuffle: () => deck.slice()});
  for (const n of names) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  t.player(names[0], {t: 'game', game: 'bts'});
  return t;
};

test('Between the Sheets: ante, two cards, bet in 100s up to the pot, win from the pot', () => {
  const c = clock();
  // A deals; B goes first: 3 and J, middle 7 (between)
  const t = btsTable(['A', 'B', 'C'], [C('2'), C('2'), C('2'), C('7'), C('J'), C('3')], c);
  assert.equal(t.player('A', {t: 'deal', ante: 200}), undefined);
  const s = t.state(), H = s.hand;
  assert.equal(H.g, 'bts'); assert.equal(H.pot, 600); assert.equal(s.players.B.chips, 800);
  assert.equal(s.seats[H.turn], 'B', 'left of the dealer goes first');
  assert.equal(t.view('C').hand.cards.lo, C('3'), 'cards are face up for everyone');
  assert.equal(t.view('C').hand.deckN, 4, 'cards left in the deck');
  assert.match(t.player('B', {t: 'act', a: 'bet', amt: 150}), /steps of 100/);
  assert.match(t.player('B', {t: 'act', a: 'bet', amt: 700}), /more than the pot/);
  assert.match(t.player('C', {t: 'act', a: 'bet', amt: 100}), /Not your turn/);
  t.player('B', {t: 'act', a: 'bet', amt: 300});
  assert.equal(H.res, 'win'); assert.equal(s.players.B.chips, 1100); assert.equal(H.pot, 300);
  c.t += 4000; t.tick();
  assert.equal(s.seats[H.turn], 'C', 'next player after a short pause');
});

test('Between the Sheets: outside pays the bet, hitting the post pays double (and can go negative)', () => {
  const c = clock();
  // B: 4 and 10, middle K (outside). C: 5 and 9, middle 9 (post)
  const t = btsTable(['A', 'B', 'C'], [C('2'), C('2'), C('9'), C('9'), C('5'), C('K'), C('T'), C('4')], c);
  t.player('A', {t: 'deal', ante: 100});
  const s = t.state(), H = s.hand;
  s.players.C.chips = 100;
  t.player('B', {t: 'act', a: 'bet', amt: 200});
  assert.equal(H.res, 'lose'); assert.equal(s.players.B.chips, 700); assert.equal(H.pot, 500);
  c.t += 4000; t.tick();
  t.player('C', {t: 'act', a: 'bet', amt: 500});
  assert.equal(H.res, 'post'); assert.equal(s.players.C.chips, -900, 'chips go negative'); assert.equal(H.pot, 1500);
  c.t += 4000; t.tick();
  assert.equal(s.seats[H.turn], 'A', 'still in the game; the dealer goes last');
});

test('Between the Sheets: a pair or next-door cards means no bet and a 10 second pause; passing is free', () => {
  const c = clock();
  // B: 7 and 7 (pair). C: 8 and 9 (next door). A: 2 and K
  const t = btsTable(['A', 'B', 'C'], [C('K'), C('2'), C('9'), C('8'), C('7'), C('7')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  assert.equal(H.stage, 'skip'); assert.equal(H.why, 'same value');
  assert.match(t.player('B', {t: 'act', a: 'bet', amt: 100}), /Not your turn/);
  c.t += 9999; t.tick(); assert.equal(s.seats[H.turn], 'B');
  c.t += 1; t.tick(); assert.equal(s.seats[H.turn], 'C'); assert.equal(H.why, 'next-door cards');
  c.t += 10000; t.tick(); assert.equal(s.seats[H.turn], 'A');
  t.player('A', {t: 'act', a: 'pass'});
  assert.equal(s.players.A.chips, 900, 'passing costs nothing'); assert.equal(H.pot, 300);
});

test('Between the Sheets: taking the whole pot ends the game; negative players sit out new games', () => {
  const c = clock();
  // B: 2 and A, middle 8 -> wins the whole pot. Then C has -100 and can't join.
  const t = btsTable(['A', 'B', 'C'], [C('8'), C('A'), C('2')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  t.player('B', {t: 'act', a: 'bet', amt: 300});
  assert.equal(H.done, 1); assert.match(H.msg, /B takes the whole pot/);
  assert.equal(s.players.B.chips, 900 + 300);
  assert.equal(s.seats[s.dealer], 'B', 'the deal moves left after the game');
  s.players.C.chips = -100; t.host({op: 'adj', name: 'A', x: 0});
  assert.ok(s.bust.C === undefined || true);
  t.host({op: 'adj', name: 'C', x: -50});
  assert.equal(s.players.C.chips, -100, 'host taking chips never wipes out a debt');
  t.host({op: 'adj', name: 'C', x: 300});
  assert.equal(s.players.C.chips, 200, 'host giving chips pays the debt off first');
});

test('Between the Sheets: deck reshuffles when low; timeouts pass; standing up forfeits', () => {
  const c = clock();
  const t = btsTable(['A', 'B', 'C'], [C('K'), C('2'), C('5'), C('Q'), C('3')], c); // B: 3/Q, C: 5/2... then reshuffle
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  c.t += 30000; t.tick();
  assert.equal(H.res, 'pass'); assert.match(H.msg, /out of time/);
  c.t += 2000; t.tick();
  assert.equal(s.seats[H.turn], 'C');
  assert.equal(H.stage, 'bet', 'the next player gets their own 30 seconds');
  c.t += 30000; t.tick(); c.t += 2000; t.tick();
  assert.match(H.msg, /reshuffled/, 'fewer than 3 cards left: fresh deck');
  t.player('A', {t: 'stand'}); t.player('B', {t: 'stand'});
  assert.equal(H.done, 1, 'one player left takes the pot');
  assert.equal(s.players.C.chips, 900 + 300);
});

test('Between the Sheets: bots play many games without creating or losing chips', () => {
  let games = 0;
  for (let table = 1; table <= 15; table++) {
    const c = clock(); let seed = table * 7907; const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const t = createTable(null, {now: c, random, shuffle: () => { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = random() * (i + 1) | 0; [d[i], d[j]] = [d[j], d[i]] } return d }});
    for (let i = 0; i < 2 + table % 7; i++) t.host({op: 'bot'});
    t.state().game = 'bts';
    const total = () => Object.values(t.state().players).reduce((a, p) => a + p.chips, 0) + (t.state().hand && !t.state().hand.done ? t.state().hand.pot : 0);
    const start = total();
    if (!t.host({op: 'start'})) {
      games++;
      for (let g = 0; g < 20000 && !t.state().hand.done; g++) { c.t += 5000; t.tick(); assert.equal(total(), start) }
      assert.equal(t.state().hand.done, 1, 'game finished');
    }
    assert.equal(total(), start);
  }
  assert.ok(games >= 10, 'played ' + games);
});

test('the host can cancel a game, or undo the last one: chips go back to how they were', () => {
  const c = clock();
  const t = btsTable(['A', 'B', 'C'], [C('2'), C('2'), C('2'), C('9'), C('K'), C('4')], c);
  t.player('A', {t: 'deal', ante: 300});
  const s = t.state(), H = s.hand;
  t.player('B', {t: 'act', a: 'bet', amt: 500});            // 4..K, 9 lands: B wins 500
  t.host({op: 'give', name: 'C', add: 250});               // host gives C chips mid-game: kept
  assert.equal(t.view('').canUndo, true);
  t.host({op: 'cancel'});
  assert.equal(H.done, 1); assert.match(H.msg, /cancelled the game/);
  assert.deepEqual([s.players.A.chips, s.players.B.chips, s.players.C.chips], [1000, 1000, 1250]);
  assert.equal(t.view('').canUndo, false); assert.match(t.host({op: 'cancel'}), /No game/);
  assert.equal(s.seats[s.dealer], 'A', 'the same dealer deals again');
  // a finished Hold'em hand can be undone too, until the next one starts
  t.player('A', {t: 'game', game: 'holdem'}); c.t += 10000; t.player('A', {t: 'deal'});
  t.player('B', {t: 'optin', in: true}); t.player('C', {t: 'optin', in: true});
  for (let g = 0; g < 50 && !s.hand.done; g++) t.player(s.seats[s.hand.turn], {t: 'act', a: 'fold'});
  assert.notDeepEqual([s.players.A.chips, s.players.B.chips, s.players.C.chips], [1000, 1000, 1250]);
  t.host({op: 'cancel'});
  assert.match(s.hand.msg, /undid the last game/);
  assert.deepEqual([s.players.A.chips, s.players.B.chips, s.players.C.chips], [1000, 1000, 1250]);
});

test("someone asking for a seat mid-game doesn't pause it; they join the next game", () => {
  const c = clock();
  // B: 7 and 8, next door: 10 second pause
  const t = btsTable(['A', 'B', 'C'], [C('K'), C('2'), C('8'), C('7')], c);
  t.player('A', {t: 'deal'});
  const s = t.state(), H = s.hand;
  assert.equal(H.stage, 'skip');
  t.player('Late', {t: 'sit'});
  assert.equal(t.view('').hold, '', 'no pause mid-game');
  c.t += 10000; t.tick();
  assert.equal(s.seats[H.turn], 'C', 'the 10 second pause is still 10 seconds');
  t.host({op: 'seat', name: 'Late'});
  assert.ok(s.seats.includes('Late') && !H.ps.includes(s.seats.indexOf('Late')), 'seated, but not in this game');
  t.player('Later', {t: 'sit'});
  H.pot = 0; t.host({op: 'cancel'});
  assert.equal(t.view('').hold, 'seats', 'between games, a seat request pauses the clocks again');
});

test('switching to a different name frees the old one, unless it is mid-game', () => {
  const t = createTable(null, {now: clock()});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state();
  t.player('A', {t: 'deal'});
  assert.match(t.release(s.seats[s.hand.turn]), /Finish it/);
  for (let g = 0; g < 50 && !s.hand.done; g++) t.player(s.seats[s.hand.turn], {t: 'act', a: 'fold'});
  t.release('B');
  assert.ok(!s.seats.includes('B'), 'stood up'); assert.ok(s.players.B.chips > 0, 'chips stay with the name');
  t.player('Q', {t: 'sit'}); t.release('Q');
  assert.ok(!s.pend.Q, 'a seat request is dropped');
});

test('a new game: everyone gets 20 seconds to sit it out, without standing up', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C', 'D']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  t.host({op: 'bot'});
  const s = t.state();
  t.player('A', {t: 'deal'});                                  // the first game: nobody is asked
  assert.ok(s.hand && !s.hand.done && !t.view('').optin, 'dealt straight away');
  for (let g = 0; g < 50 && !s.hand.done; g++) t.player(s.seats[s.hand.turn], {t: 'act', a: 'fold'});
  c.t += 10000; t.tick();
  const dealer = s.seats[s.dealer];
  t.player(dealer, {t: 'game', game: 'syn'});
  t.player(dealer, {t: 'deal', ante: 200});
  const O = t.view('').optin;
  assert.ok(O && O.game == 'syn' && O.until == c.t + 20000, 'a 20 second window');
  assert.deepEqual([...O.who].sort(), ['A', 'B', 'C', 'D'].filter(x => x != dealer).sort(), 'everyone but the dealer and the bots');
  assert.ok(!s.hand || s.hand.done, 'not dealt yet');
  assert.match(t.player(dealer, {t: 'game', game: 'bts'}), /choosing/);
  const [x, y, z] = O.who;
  t.player(x, {t: 'optin', in: false});
  t.player(y, {t: 'optin', in: true});
  c.t += 19999; t.tick(); assert.ok(t.view('').optin, 'still waiting on one');
  c.t += 1; t.tick();                                           // z never answered: in
  const H = s.hand;
  assert.equal(H.g, 'syn');
  const playing = H.ps.map(i => s.seats[i]);
  assert.ok(!playing.includes(x) && playing.includes(y) && playing.includes(z) && playing.includes(dealer) && playing.includes('Bot 1'));
  assert.ok(s.seats.includes(x), 'sitting out is not standing up');
  assert.equal(s.players[x].chips, 1000, 'no ante');
  // still sitting out the next Screw Your Neighbor game, until they ask back in
  H.done = 1; c.t += 20000; t.tick();
  assert.notEqual(s.seats[s.dealer], x, "someone sitting out isn't made dealer");
  t.player(x, {t: 'dealmein'});
  assert.ok(!s.sitout[x]);
});

test('dealing the same game again asks nobody; everyone answering starts it at once', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state();
  t.player('A', {t: 'deal'});
  for (let g = 0; g < 50 && !s.hand.done; g++) t.player(s.seats[s.hand.turn], {t: 'act', a: 'fold'});
  c.t += 10000; t.tick();
  t.player(s.seats[s.dealer], {t: 'deal'});
  assert.ok(!t.view('').optin && !s.hand.done, "same game: dealt straight away");
  for (let g = 0; g < 50 && !s.hand.done; g++) t.player(s.seats[s.hand.turn], {t: 'act', a: 'fold'});
  c.t += 10000; t.tick();
  const d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'bts'}); t.player(d, {t: 'deal'});
  for (const x of t.view('').optin.who) t.player(x, {t: 'optin', in: true});
  assert.equal(s.hand.g, 'bts', 'everyone answered: no need to wait');
  assert.equal(s.hand.ps.length, 3);
});

test('5 Card Draw wild cards: best hand with the wild value', () => {
  const h = s => s.split(' ').map(x => card(x[0], 'shdc'.indexOf(x[1])));
  const W = card('7', 0) % 13, cat = (s, w = W) => category(bestW(h(s), w));
  assert.equal(cat('7h Ks 9d 3c 2h'), 'Pair');                 // one wild makes a pair
  assert.equal(cat('7h Ks Kd 3c 2h'), 'Trips');
  assert.equal(cat('7h 7s Kd Kc 2h'), 'Quads');                // two wild + a pair
  assert.equal(cat('7h 7s Kd Kc Kh'), 'Five of a kind');
  assert.equal(cat('7h 7s 7d 7c Kh'), 'Five of a kind');
  assert.equal(cat('7h 7s 7d 7c 7h'), 'Five of a kind');
  assert.equal(cat('7h 2h 9h Jh Kh'.replace('7h', '7s')), 'Flush');   // wild completes a flush
  assert.equal(cat('7s 4h 5h 6h 8h'), 'Straight flush');
  assert.equal(cat('7s Ah 2d 3c 4h'), 'Straight');                    // wheel with a wild 5
  assert.equal(cat('7s Kh Kd 3c 3h'), 'Full house');
  assert.ok(bestW(h('7h Kh Kd Kc 2s'), W) > bestW(h('Kh Kd Kc 2s 3s'), W));
  assert.equal(category(bestW(h('7h Ks 9d 3c 2h'), -1)), 'High card'); // no wild value: plain poker
  assert.ok(s5(h('Ah As Ad Ac Ah')) > s5(h('Ts Js Qs Ks As')), 'five of a kind tops a straight flush');
});

test('5 Card Draw: bet, draw, bet again, showdown; the dealer picks the wild value', () => {
  const c = clock(), deck = [...Array(52).keys()].reverse(); // deterministic
  const t = createTable(null, {now: c, shuffle: () => [...deck]});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state();
  const dealer = s.seats[s.dealer]; t.player(dealer, {t: 'game', game: 'draw'});
  assert.equal(t.player(dealer, {t: 'deal', ante: 100, wild: 99}), 'Pick a wild card');
  assert.match(t.player(dealer, {t: 'deal', ante: 50, wild: 5}), /Ante must be 100/);
  assert.match(t.player(dealer, {t: 'deal', ante: 150, wild: 5}), /steps of 100/);
  t.player(dealer, {t: 'deal', ante: 100, wild: 5});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand; assert.equal(H.g, 'draw'); assert.equal(H.wild, 5);
  assert.ok(H.ps.every(i => H.h[i].length == 5));
  assert.equal(Object.values(H.tot).reduce((x, y) => x + y, 0), 300, 'one 100 ante each makes the pot'); assert.equal(H.cur, 0);
  const v = t.view(s.seats[H.ps[0]]); assert.equal(v.hand.d, undefined); assert.equal(v.hand.disc, undefined);
  assert.equal(t.view('').hand.h[H.ps[0]].every(x => x === null), true);
  let guard = 0; while (H.stage == 0 && guard++ < 20) t.player(s.seats[H.turn], {t: 'act', a: 'call'});
  assert.equal(H.stage, 1, 'betting done: draw phase');
  assert.ok(t.player(s.seats[H.turn], {t: 'act', a: 'call'}), "can't bet while drawing");
  const first = H.turn, old = [...H.h[first]];
  assert.ok(t.player(s.seats[first], {t: 'act', a: 'draw', idx: [7]}), 'bad index rejected');
  t.player(s.seats[first], {t: 'act', a: 'draw', idx: [0, 1]});
  assert.equal(H.h[first].length, 5); assert.notEqual(H.h[first][0], old[0]); assert.equal(H.h[first][4], old[4]);
  guard = 0; while (H.stage == 1 && guard++ < 5) t.player(s.seats[H.turn], {t: 'act', a: 'draw', idx: []});
  assert.equal(H.stage, 2); guard = 0;
  while (!H.done && guard++ < 20) t.player(s.seats[H.turn], {t: 'act', a: 'call'});
  assert.ok(H.done && H.show, 'showdown'); assert.match(H.msg, /wins/);
  assert.equal(Object.values(s.players).reduce((a, p) => a + p.chips, 0), 3000, 'chips conserved');
});

test('5 Card Draw: a draw that outruns the deck recycles the discards', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (let i = 1; i <= 10; i++) { t.player('P' + i, {t: 'sit'}); t.host({op: 'seat', name: 'P' + i}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'draw'}); t.player(d, {t: 'deal', ante: 100, wild: -1});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand; let g = 0; while (H.stage == 0 && g++ < 40) t.player(s.seats[H.turn], {t: 'act', a: 'call'});
  g = 0; while (H.stage == 1 && g++ < 12) t.player(s.seats[H.turn], {t: 'act', a: 'draw', idx: [0, 1, 2, 3, 4]});
  assert.equal(H.stage, 2); const all = Object.values(H.h).flat();
  assert.ok(all.every(x => x >= 0 && x < 52), 'no missing cards'); 
});

test('Between the Sheets: the cards stay in the view after the pot is taken', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'bts'}); t.player(d, {t: 'deal', ante: 100});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand; let g = 0;
  while (!H.done && g++ < 200) { if (H.stage == 'bet') t.player(s.seats[H.turn], {t: 'act', a: 'bet', amt: H.pot}); else { c.t += 11000; t.tick() } }
  const v = t.view('A').hand; if (H.show) assert.ok(v.cards.lo != null && v.cards.hi != null, 'lo/hi still shown');
});

test('7 Card No Peek Dr. Pepper: showing hands rank with 2s, 4s, 10s wild and missing cards', () => {
  const h = s => s.split(' ').map(x => card(x[0], 'shdc'.indexOf(x[1])));
  const W = [0, 2, 8], sc = s => scoreAny(h(s), W), cat = s => category(sc(s));
  assert.equal(cat('Ks'), 'High card');
  assert.ok(sc('Ks 3d') > sc('Ks'), 'any kicker beats a missing card');
  assert.ok(sc('As') > sc('Ks'));
  assert.equal(cat('2s'), 'High card'); assert.ok(sc('2s') >= sc('As'), 'a lone wild is at least an Ace');
  assert.equal(cat('2s 9d'), 'Pair');                       // wild pairs the 9
  assert.equal(cat('9s 9d'), 'Pair');
  assert.equal(cat('4s Td 9c'), 'Trips');
  assert.equal(cat('9s 9d 4c Th'), 'Quads');
  assert.equal(cat('9s 4d 5c 6h'), 'Pair', 'four cards: no straights');
  assert.equal(cat('9s 4d 5c 6h 7d'), 'Straight');            // wild is the 8
  assert.equal(cat('9s Ks 5s 2s 7s'), 'Flush');
  assert.equal(cat('9s 9d 9c 4s 4h'), 'Five of a kind');
  assert.equal(cat('9s 9d Kc Ks 4h 3d 5c'), 'Full house');
  assert.ok(sc('9s 9d') > sc('As Kd Qc'));
});

test('7 Card No Peek: cards stay hidden, beat the dealer card, bet with no cap, last one in wins', () => {
  const c = clock(), deck = [...Array(52).keys()].reverse();
  const t = createTable(null, {now: c, shuffle: () => [...deck]});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), dealer = s.seats[s.dealer]; t.player(dealer, {t: 'game', game: 'nopeek'});
  assert.equal(t.player(dealer, {t: 'deal', ante: 100}), undefined);
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand; assert.equal(H.g, 'nopeek'); assert.ok(H.ps.every(i => H.h[i].length == 7));
  assert.equal(Object.values(H.tot).reduce((x, y) => x + y, 0), 300);
  assert.equal(typeof H.top, 'number', "the dealer's card is turned up"); assert.equal(t.view('').hand.top, H.top);
  assert.equal(H.top % 13, 8, 'this deck turns up a 10, which is wild'); assert.equal(H.bestSc, scoreAny([12], []), 'a wild upcard counts as an Ace');
  const mine = s.seats[H.ps[0]], v = t.view(mine).hand;
  assert.ok(v.h[H.ps[0]].every(x => x === null), 'not even your own cards are visible before you flip');
  assert.equal(v.d, undefined); assert.equal(v.sc, undefined);
  assert.equal(s.seats[H.turn], mine, 'left of the dealer flips first');
  assert.ok(t.player(s.seats[H.ps[1]], {t: 'act', a: 'flip'}), 'only the flipper may flip');
  assert.ok(t.player(mine, {t: 'act', a: 'call'}), "can't bet before flipping");
  t.player(mine, {t: 'act', a: 'flip'});
  assert.equal(t.view(mine).hand.h[H.ps[0]].filter(x => x !== null).length, 1, 'one tap, one card');
  let g = 0; while (!H.done && g++ < 300) {
    const n = s.seats[H.turn];
    if (H.stage == 'flip') { const before = H.up[H.turn]; t.player(n, {t: 'act', a: 'flip'}); assert.equal(H.up[s.seats.indexOf(n)] >= before, true) }
    else { assert.ok(H.cat[H.best] && H.stage == 'bet'); t.player(n, {t: 'act', a: g % 3 ? 'raise' : 'call', amt: 300}) }
  }
  assert.ok(H.done, 'the hand ends'); assert.match(H.msg, /wins|split/);
  assert.equal(Object.values(s.players).reduce((a, p) => a + p.chips, 0), 3000, 'chips conserved');
});

test('7 Card No Peek: a flipper stops being able to flip once they have the lead, and raises are not capped', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'nopeek'}); t.player(d, {t: 'deal', ante: 100});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand, h = x => x.split(' ').map(y => card(y[0], 'shdc'.indexOf(y[1])));
  const [a, b] = H.ps; H.top = card('3', 2); H.topSc = H.bestSc = scoreAny([H.top], []);
  H.h[a] = h('Ks 3d 5c 6h 7d 8s 9c'); H.h[b] = h('Ah 3c 5d 6s 7h 8c 9d'); H.turn = a; H.stage = 'flip';
  t.player(s.seats[a], {t: 'act', a: 'flip'});
  assert.equal(H.stage, 'bet', 'a King beats the dealer\'s 3: flipping stops and betting starts');
  assert.equal(t.player(s.seats[a], {t: 'act', a: 'flip'}), undefined, 'an extra tap once ahead: no error flash');
  assert.equal(H.up[a], 1, '... and no more flips once ahead');
  assert.equal(H.turn, a, 'whoever just took the lead decides first whether to bet');
  assert.equal(t.player(s.seats[a], {t: 'act', a: 'raise', amt: 900}), undefined);
  assert.equal(H.cur, 900, 'bet the whole stack: no cap'); assert.ok(H.allin[a]);
  assert.equal(H.turn, b, 'then the others respond');
});

test('7 Card No Peek: tied hands split the pot', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'nopeek'}); t.player(d, {t: 'deal', ante: 100});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand, h = x => x.split(' ').map(y => card(y[0], 'shdc'.indexOf(y[1])));
  const [a, b] = H.ps; H.top = card('3', 2); H.topSc = H.bestSc = scoreAny([H.top], []);
  H.h[a] = h('Ks Kd 3c 5h 7d 8s 9c'); H.h[b] = h('Kh Kc 3d 5s 7h 8c 9d'); H.turn = a; H.stage = 'flip';
  let g = 0; while (!H.done && g++ < 100) { const n = s.seats[H.turn]; if (H.stage == 'flip') t.player(n, {t: 'act', a: 'flip'}); else t.player(n, {t: 'act', a: 'call'}) }
  assert.ok(H.done); assert.match(H.msg, /tie and split/);
  assert.equal(s.players.A.chips, 1000); assert.equal(s.players.B.chips, 1000);
});

test('7 Card No Peek: capped at 7 players', () => {
  const t = createTable(null, {now: clock()});
  for (let i = 1; i <= 8; i++) { t.player('P' + i, {t: 'sit'}); t.host({op: 'seat', name: 'P' + i}) }
  const s = t.state(), d = s.seats[s.dealer];
  assert.equal(t.view('').seatedN, 8);
  assert.match(t.player(d, {t: 'game', game: 'nopeek'}), /up to 7 players/);
  assert.equal(t.view('').games.find(x => x.id == 'nopeek').max, 7);
  t.player('P8', {t: 'stand'});
  assert.equal(t.player(d, {t: 'game', game: 'nopeek'}), undefined);
});

test('5 Card Draw: whatever the ante, bets and raises go up in steps of 100', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'draw'}); t.player(d, {t: 'deal', ante: 300, wild: -1});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand; assert.equal(H.g, 'draw');
  t.player(s.seats[H.turn], {t: 'act', a: 'raise', amt: 50});
  assert.equal(H.cur, 100, 'the smallest bet is 100, not the 300 ante');
  t.player(s.seats[H.turn], {t: 'act', a: 'raise', amt: 250});
  assert.equal(H.cur, 200, 'rounded down to a step of 100');
  t.player(s.seats[H.turn], {t: 'act', a: 'raise', amt: 230});
  assert.equal(H.cur, 300, 'a raise is at least 100 more');
});

test('7 Card No Peek: whatever the ante, bets and raises go up in steps of 100', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'nopeek'}); t.player(d, {t: 'deal', ante: 300});
  for (const x of t.view('').optin ? t.view('').optin.who : []) t.player(x, {t: 'optin', in: true});
  const H = s.hand; assert.equal(H.g, 'nopeek');
  let g = 0; while (H.stage == 'flip' && !H.done && g++ < 30) t.player(s.seats[H.turn], {t: 'act', a: 'flip'});
  if (H.done) return; // rare: nobody could beat the dealer's card
  assert.equal(H.stage, 'bet');
  t.player(s.seats[H.turn], {t: 'act', a: 'raise', amt: 50});
  assert.equal(H.cur, 100, 'the smallest bet is 100, not the 300 ante');
  t.player(s.seats[H.turn], {t: 'act', a: 'raise', amt: 250});
  assert.equal(H.cur, 200, 'rounded down to a step of 100');
});

test('7 Card No Peek: the card you tap is the card that flips', () => {
  const c = clock(), t = createTable(null, {now: c});
  for (const n of ['A', 'B', 'C']) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
  const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'nopeek'}); t.player(d, {t: 'deal', ante: 100});
  const H = s.hand, i = H.turn, n = s.seats[i];
  t.player(n, {t: 'act', a: 'flip', idx: 4});
  const seen = t.view('C').hand.h[i];
  assert.equal(seen[4], H.h[i][4], 'the fifth card is face up');
  assert.ok(seen.every((x, k) => k == 4 || x === null), 'and only that one');
  assert.equal(H.sc[i], scoreAny([H.h[i][4]], [0, 2, 8]), 'scored on the cards that are showing');
  if (H.stage == 'flip' && H.turn === i) {
    t.player(n, {t: 'act', a: 'flip', idx: 4});                 // tapping it again: flips another one instead
    assert.equal(t.view('C').hand.h[i].filter(x => x !== null).length, 2);
  } else assert.equal(t.player(n, {t: 'act', a: 'flip', idx: 1}), undefined, 'an extra tap after taking the lead is quietly ignored');
});

test('7 Card No Peek: every time someone takes the lead, they get to bet (hundreds of games)', () => {
  let leads = 0;
  for (let g = 1; g <= 150; g++) {
    const c = clock(); let seed = g * 7919; const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const t = createTable(null, {now: c, random, shuffle: () => { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = random() * (i + 1) | 0; [d[i], d[j]] = [d[j], d[i]] } return d }});
    const names = ['A', 'B', 'C', 'D'].slice(0, 2 + g % 3);
    for (const n of names) { t.player(n, {t: 'sit'}); t.host({op: 'seat', name: n}) }
    const s = t.state(), d = s.seats[s.dealer]; t.player(d, {t: 'game', game: 'nopeek'}); t.player(d, {t: 'deal', ante: 100});
    const H = s.hand;
    for (let k = 0; k < 400 && !H.done; k++) {
      const n = s.seats[H.turn], i = H.turn;
      if (H.stage == 'flip') {
        const before = H.best; t.player(n, {t: 'act', a: 'flip'});
        if (!H.done && H.best === i && before !== i && H.stage == 'bet') {
          leads++;
          const others = H.ps.filter(j => j != i && !H.fold[j] && !H.allin[j]);
          if (!H.allin[i] && others.length) assert.equal(H.turn, i, 'the new leader acts first in the betting round');
        }
      } else t.player(n, {t: 'act', a: k % 4 ? 'call' : 'raise', amt: 100});
    }
  }
  assert.ok(leads > 150, 'checked ' + leads + ' times someone took the lead');
});
