'use strict';
// Poker table engine: pure game logic, no networking. The server owns one table,
// feeds it player/host requests, and sends each viewer view(name) — which never
// includes the deck or anyone else's hole cards.
const crypto = require('crypto');

// Dealer's choice: the dealer picks the game between hands. Games list in this order.
const GAMES = {
  holdem: {name: "Texas Hold'em", hole: 2, ready: true, blurb: 'Two hole cards, five on the board. Best five-card hand wins.'},
  syn: {name: 'Screw Your Neighbor', ready: true, blurb: 'One card each: keep it or swap left. Lowest card loses a life; last one standing takes the pot.'},
  bts: {name: 'Between the Sheets', ready: true, blurb: 'Two cards face up: bet the next one lands between them. Hit the post and pay double.'},
};
const HN = ['High card', 'Pair', 'Two pair', 'Trips', 'Straight', 'Flush', 'Full house', 'Quads', 'Straight flush'];
const LIVES = 4, REVEAL = 5000, SKIP = 10000, RESULT = 4000, PASSED = 2000, AGAIN = 30000, WAIT = 10000, BUST = 30000, TURN = 30000, ACE_TURN = 5000, DEAL = 120000, MISSES = 3, BOT_DELAY = 5000, SEATS = 12;

// ---------- hand evaluation (cards are 0..51: rank c%13, 0='2'..12='A'; suit c/13) ----------
function s5(c) {
  const r = c.map(x => 2 + x % 13).sort((a, b) => b - a), f = c.every(x => (x / 13 | 0) == (c[0] / 13 | 0)), m = {};
  r.forEach(x => m[x] = (m[x] || 0) + 1);
  const g = Object.keys(m).map(Number).sort((a, b) => m[b] - m[a] || b - a), u = [...new Set(r)];
  let st = 0;
  if (u.length == 5) { if (u[0] - u[4] == 4) st = u[0]; else if (u[0] == 14 && u[1] == 5) st = 5 }
  const k = g.map(x => m[x]).join(''),
    cat = st && f ? 8 : k == '41' ? 7 : k == '32' ? 6 : f ? 5 : st ? 4 : k == '311' ? 3 : k == '221' ? 2 : k == '2111' ? 1 : 0,
    t = st ? [st] : g;
  while (t.length < 5) t.push(0);
  return t.reduce((a, x) => a * 15 + x, cat);
}
function best(c) {
  let m = 0; const n = c.length;
  (function f(s, a) { if (a.length == 5) { m = Math.max(m, s5(a)); return } for (let i = s; i < n; i++) f(i + 1, [...a, c[i]]) })(0, []);
  return m;
}
const category = score => HN[Math.floor(score / 15 ** 5)];

function cryptoShuffle() {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]] }
  return d;
}

const fresh = () => ({players: {}, seats: Array(SEATS).fill(''), pend: {}, queue: [], leave: {}, bust: {}, buy: {}, wait: 0,
  hand: null, btn: -1, dealer: -1, dealDl: 0, sb: 5, bb: 10, ante: 100, game: 'holdem', n: 0, last: -1, known: {}});
const int = v => { const x = Math.floor(+v); return Number.isFinite(x) ? x : NaN };
// the dealer picks the big blind: at least 10, in steps of 10; the small blind is always half
const blindError = bb => bb >= 10 && bb % 10 == 0 ? '' : 'Blind must be 10 or more, in steps of 10';
// Screw Your Neighbor: one ante to join the game, 100 or more in steps of 100
const anteError = a => a >= 100 && a % 100 == 0 ? '' : 'Ante must be 100 or more, in steps of 100';
const ACE = 12; // card rank index: 0 = '2' .. 12 = 'A' (Ace high in both games)

/**
 * opts: now() clock, random() for bots, shuffle() -> 52-card deck (last card dealt first),
 * onChange() after every mutation (persist + broadcast).
 */
function createTable(saved, {now = Date.now, random = Math.random, shuffle = cryptoShuffle, onChange = () => {}} = {}) {
  const S = Object.assign(fresh(), saved || {});
  // a restart shouldn't time out whoever was mid-decision
  if (S.hand && !S.hand.done) S.hand.dl = now() + TURN;
  S.dealDl = 0; delete S.pausedAt; S.queue = S.queue || []; S.ante = S.ante || 100;
  // name history: everyone who has played here, bots excluded
  for (const n in S.players) if (!S.players[n].bot && !S.known[n]) S.known[n] = 1;
  let botAt = 0, botDealAt = 0;

  function changed() {
    S.n++; tidy(); queueUpkeep(); dealerUpkeep(); freezeUpkeep();
    const H = S.hand, p = H && !H.done && S.players[S.seats[H.turn]];
    botAt = p && p.bot ? now() + BOT_DELAY : 0;
    // each new decision gets a fresh 30s turn clock (bots move on their own timer)
    if (H && !H.done) { const key = H.turn + ':' + (H.nact || 0); if (H.dlKey !== key) { H.dlKey = key; H.dl = p && !p.bot ? now() + (holdsAce(H.turn) ? ACE_TURN : TURN) : 0 } }
    onChange();
  }
  const freeSeat = () => { for (let k = 1; k <= SEATS; k++) { const i = ((S.last ?? -1) + k + SEATS) % SEATS; if (!S.seats[i]) return i } return -1 };
  const live = () => S.hand && !S.hand.done;
  const syn = () => S.hand && S.hand.g == 'syn';
  const bts = () => S.hand && S.hand.g == 'bts';
  const holdem = () => S.hand && !syn() && !bts();
  const inLiveHand = n => {
    const i = S.seats.indexOf(n), H = S.hand; if (!live() || i < 0) return false;
    return syn() ? H.lives[i] > 0 : bts() ? H.ps.includes(i) && !H.out[i] : H.ps.includes(i) && !H.fold[i];
  };
  // seated players at 0 chips who haven't stood up hold the next deal
  const owed = () => S.seats.filter(n => n && S.players[n].chips <= 0);
  function tidy() {
    for (const n of Object.keys(S.bust).concat(Object.keys(S.buy)))
      if (!S.seats.includes(n) || S.players[n].chips > 0) { delete S.bust[n]; delete S.buy[n] }
  }
  // ---------- cancel a game: everyone gets back the chips they had when it started ----------
  const takeSnap = () => ({chips: Object.fromEntries(Object.entries(S.players).map(([n, p]) => [n, p.chips])), carry: S.carry || 0, btn: S.btn, dealer: S.dealer});
  // chips the host hands out during a game are kept if the game is cancelled
  function hostChips(n, d) { if (S.snap && n in S.snap.chips) S.snap.chips[n] += d }
  function cancelGame() {
    const sn = S.snap, H = S.hand; if (!sn || !H) return 'No game to cancel';
    for (const n in sn.chips) if (S.players[n]) S.players[n].chips = sn.chips[n];
    S.carry = sn.carry; S.btn = sn.btn; S.dealer = sn.dealer; S.dealDl = 0; S.again = null; S.snap = null;
    const was = !H.done; H.done = 1; H.show = 0; H.turn = -1;
    H.msg = (was ? 'The host cancelled the game' : 'The host undid the last game') + ': everyone has the chips they had before it';
    Object.keys(S.leave).forEach(stand); S.wait = now();
  }

  // ---------- the dealer (button) deals the next hand and picks the blinds ----------
  const eligible = i => { const n = S.seats[i]; return !!n && S.players[n].chips > 0 && !S.leave[n] };
  function nextEligible(from) { for (let k = 1; k <= SEATS; k++) { const i = (from + k + SEATS) % SEATS; if (eligible(i)) return i } return -1 }
  const canDeal = () => !live() && !S.again && !owed().length && S.seats.filter((n, i) => eligible(i)).length >= 2;
  // keep `dealer` on a seat that can deal, and run its 2-minute clock once dealing is possible (after the 10s pause)
  function dealerUpkeep() {
    if (live()) { S.dealDl = 0; return }
    if (S.dealer < 0 || !eligible(S.dealer)) { S.dealer = nextEligible(S.dealer >= 0 ? S.dealer : S.btn); S.dealDl = 0 }
    if (!canDeal()) S.dealDl = 0;
    else if (!S.dealDl) S.dealDl = Math.max(now(), S.wait) + DEAL;
  }
  // ---------- waitlist: when every seat is taken or spoken for, people line up ----------
  const openSeats = () => S.seats.filter(n => !n).length - Object.keys(S.pend).length;
  // a seat opened up: the front of the line becomes a seat request for the host
  function queueUpkeep() { while (S.queue.length && openSeats() > 0) S.pend[S.queue.shift()] = 1 }
  // ---------- frozen clocks: the host's Pause, or someone waiting for the host to seat them ----------
  const holdReason = () => S.paused ? 'host' : Object.keys(S.pend).length ? 'seats' : '';
  function freezeUpkeep() {
    const want = !!holdReason();
    if (want && !S.frozenAt) S.frozenAt = now();
    else if (!want && S.frozenAt) {
      // push every deadline back by however long the clocks were frozen
      const d = now() - S.frozenAt, H = S.hand; S.frozenAt = 0;
      if (S.wait) S.wait += d; if (S.dealDl) S.dealDl += d; for (const n in S.bust) S.bust[n] += d;
      if (H && H.dl) H.dl += d; if (H && H.nextAt) H.nextAt += d; if (botDealAt) botDealAt += d; if (S.again) S.again.until += d; if (botAt) botAt += d;
    }
  }
  function stand(n) { const i = S.seats.indexOf(n); if (i >= 0) S.seats[i] = ''; delete S.leave[n]; delete S.bust[n]; delete S.buy[n]; if (S.players[n]) S.players[n].miss = 0 }
  // standing up mid-hand: fold when the action reaches them, leave the seat when the hand ends
  function standOrLeave(n) {
    if (!inLiveHand(n)) return stand(n);
    S.leave[n] = 1;
    if (syn()) synForfeit(n); else if (bts()) btsForfeit(n); else autoFold();
  }

  // ---------- betting ----------
  function nxt(f) { const H = S.hand, L = H.ps.length, o = H.ps.indexOf(f); for (let k = 1; k <= L; k++) { const s = H.ps[(o + k) % L]; if (!H.fold[s] && !H.allin[s]) return s } return -1 }
  function post(i, a) { const H = S.hand, p = S.players[S.seats[i]]; a = Math.max(0, Math.min(a, p.chips)); p.chips -= a; H.bet[i] += a; H.tot[i] += a; if (p.chips == 0) H.allin[i] = 1 }
  function startHand() {
    if (live()) return 'Hand in progress';
    const o = owed(); if (o.length) return 'Waiting on ' + o.join(', ') + ' to get chips or stand up';
    if (S.again) return 'Waiting for players to ante again';
    if (now() < S.wait) return 'Next hand can be dealt in a moment';
    const p = Object.keys(S.pend); if (p.length) return 'Waiting for the host to seat ' + p.join(', ');
    const g = GAMES[S.game], nb = S.dealer >= 0 && eligible(S.dealer) ? S.dealer : nextEligible(S.btn);
    // remember everyone's chips, so the host can cancel this game and give them back
    const snap = takeSnap();
    if (S.game == 'syn' || S.game == 'bts') { const e = S.game == 'syn' ? startSyn(nb) : startBts(nb); if (!e) S.snap = snap; return e }
    const ps = []; for (let k = 1; k <= SEATS; k++) { const i = (nb + k) % SEATS, n = S.seats[i]; if (n && S.players[n].chips > 0) ps.push(i) }
    if (ps.length < 2) return 'Need at least 2 seated players with chips';
    S.btn = S.dealer = nb; S.dealDl = 0; S.snap = snap; const d = shuffle();
    const h = {}, bet = {}, tot = {}; ps.forEach(i => { h[i] = Array.from({length: g.hole}, () => d.pop()); bet[i] = 0; tot[i] = 0 });
    const H = S.hand = {g: 'holdem', ps, btn: nb, d, board: [], h, bet, tot, fold: {}, allin: {}, acted: {}, stage: 0, cur: S.bb, minR: S.bb, turn: -1, done: 0, show: 0, msg: 'New hand'};
    const hu = ps.length == 2, sb = hu ? ps[1] : ps[0], bb = hu ? ps[0] : ps[1], first = hu ? ps[1] : ps[2 % ps.length];
    post(sb, S.sb); post(bb, S.bb);
    H.turn = H.allin[first] ? nxt(first) : first;
    if (H.turn < 0) adv(); // everyone all-in from the blinds: run the board out
    autoFold();
  }
  const endHand = () => afterGame();
  // a hand (or a whole Screw Your Neighbor game) is over; keepDealer: the same dealer deals again
  function afterGame(keepDealer) {
    const t = now(); S.hand.done = 1; S.wait = t + WAIT; Object.keys(S.leave).forEach(stand);
    S.seats.forEach(n => { if (n && S.players[n].chips <= 0) { if (S.players[n].bot) stand(n); else if (!S.buy[n]) S.bust[n] = t + BUST } });
    S.dealer = keepDealer && eligible(S.hand.btn) ? S.hand.btn : nextEligible(S.hand.btn); S.dealDl = 0; // the button moves one to the left
  }
  function finish(lv) { const H = S.hand, n = S.seats[lv[0]], pot = Object.values(H.tot).reduce((a, b) => a + b, 0); S.players[n].chips += pot; H.msg = n + ' wins ' + pot; endHand() }
  function showdown(lv) {
    const H = S.hand, sc = {}; lv.forEach(i => sc[i] = best(H.h[i].concat(H.board)));
    const levels = [...new Set(lv.map(i => H.tot[i]))].sort((a, b) => a - b), win = {}; let pv = 0;
    levels.forEach(L => {
      let pot = 0; H.ps.forEach(i => pot += Math.min(H.tot[i], L) - Math.min(H.tot[i], pv)); pv = L;
      const el = lv.filter(i => H.tot[i] >= L), mx = Math.max(...el.map(i => sc[i])), w = el.filter(i => sc[i] == mx), sh = Math.floor(pot / w.length);
      w.forEach((i, k) => { const n = S.seats[i], g = sh + (k ? 0 : pot - sh * w.length); S.players[n].chips += g; win[n] = (win[n] || 0) + g });
    });
    H.msg = Object.keys(win).map(n => n + ' wins ' + win[n] + ' (' + category(sc[S.seats.indexOf(n)]) + ')').join(', ');
    H.show = 1; endHand();
  }
  function adv() {
    const H = S.hand, lv = H.ps.filter(i => !H.fold[i]); if (lv.length == 1) return finish(lv);
    const can = lv.filter(i => !H.allin[i]);
    if (!can.every(i => H.acted[i] && H.bet[i] == H.cur)) { H.turn = nxt(H.turn); return }
    while (true) {
      if (H.stage == 3) return showdown(lv);
      H.stage++; for (let k = H.stage == 1 ? 3 : 1; k > 0; k--) H.board.push(H.d.pop());
      H.ps.forEach(i => H.bet[i] = 0); H.cur = 0; H.acted = {}; H.minR = S.bb;
      if (can.length > 1) { H.turn = nxt(H.ps[H.ps.length - 1]); return }
    }
  }
  function act(n, a, amt) {
    const H = S.hand; if (!live()) return; const t = H.turn; if (S.seats[t] !== n) return;
    const p = S.players[n], b = H.bet[t], need = H.cur - b;
    if (a == 'fold') { H.fold[t] = 1; H.msg = n + ' folds' }
    else {
      let to = a == 'raise' ? int(amt) || 0 : 0; const mx = b + p.chips; to = Math.min(to, mx);
      if (a != 'raise' || to <= H.cur) { post(t, need); H.msg = n + (need > 0 ? ' calls ' + Math.min(need, b + p.chips) : ' checks') }
      else {
        // bets go up in steps of the big blind (a raise of at least one big blind); all-in can be any amount
        const step = S.bb, least = Math.ceil((H.cur + step) / step) * step;
        if (to < mx) to = Math.min(Math.max(least, Math.floor(to / step) * step), mx);
        H.cur = to; H.acted = {}; post(t, to - b); H.msg = n + (H.allin[t] ? ' is all-in ' : ' raises to ') + to;
      }
    }
    H.acted[t] = 1; H.nact = (H.nact || 0) + 1; adv(); autoFold();
  }
  function autoFold() { const H = S.hand; if (live() && holdem() && S.leave[S.seats[H.turn]]) act(S.seats[H.turn], 'fold') }

  // ---------- Between the Sheets ----------
  // One ante each makes the pot. From the dealer's left (dealer last), round and round: you get two cards
  // face up (Aces high) and bet, in 100s up to the whole pot, that the next card lands strictly between
  // them, or pass for free. Between: take your bet from the pot. Outside: pay it in. Same rank as either
  // (hitting the post): pay double; chips can go below zero here. Next-door cards or a pair: no bet,
  // 10s pause. The same dealer deals until someone takes the last of the pot.
  function startBts(nb) {
    const ps = []; for (let k = 1; k <= SEATS; k++) { const i = (nb + k) % SEATS, n = S.seats[i]; if (n && S.players[n].chips >= S.ante) ps.push(i) }
    if (ps.length < 2) return 'Need at least 2 seated players who can cover the ante of ' + S.ante;
    S.btn = S.dealer = nb; S.dealDl = 0;
    ps.forEach(i => S.players[S.seats[i]].chips -= S.ante);
    S.hand = {g: 'bts', ps, btn: nb, pot: ps.length * S.ante, ante: S.ante, d: shuffle(), out: {}, cards: {}, stage: 'bet',
      turn: -1, nact: 0, done: 0, show: 0, msg: '', res: ''};
    btsDeal(ps[0]);
  }
  const btsIn = () => S.hand.ps.filter(i => !S.hand.out[i]);
  function btsDeal(i) {
    const H = S.hand, re = H.d.length < 3; if (re) H.d = shuffle();
    H.turn = i; H.nact++; H.res = ''; H.bet = 0; H.nextAt = 0; H.dl = 0; // a fresh turn clock is set on the next change
    const a = H.d.pop(), b = H.d.pop(), ra = rank(a), rb = rank(b), n = S.seats[i];
    H.cards = {lo: ra <= rb ? a : b, hi: ra <= rb ? b : a, mid: null};
    const why = ra == rb ? 'same value' : Math.abs(ra - rb) == 1 ? 'next-door cards' : '';
    if (why) { H.stage = 'skip'; H.why = why; H.nextAt = now() + SKIP; H.msg = n + ': no bet, ' + why }
    else { H.stage = 'bet'; H.why = ''; H.msg = n + "'s turn" }
    if (re) H.msg += ' · deck reshuffled';
  }
  function btsNext() {
    const H = S.hand, k = H.ps.indexOf(H.turn);
    for (let s = 1; s <= H.ps.length; s++) { const i = H.ps[(k + s) % H.ps.length]; if (!H.out[i]) return btsDeal(i) }
  }
  function btsAct(n, a, amt) {
    const H = S.hand, i = S.seats.indexOf(n);
    if (H.stage != 'bet' || H.turn !== i) return 'Not your turn';
    if (a == 'pass') { H.stage = 'result'; H.res = 'pass'; H.msg = n + ' passes'; H.nextAt = now() + PASSED; return }
    if (a != 'bet') return;
    const bet = int(amt);
    if (!(bet >= 100 && bet % 100 == 0)) return 'Bets are 100 or more, in steps of 100';
    if (bet > H.pot) return "You can't bet more than the pot (" + H.pot + ')';
    const c = H.d.pop(), r = rank(c), lo = rank(H.cards.lo), hi = rank(H.cards.hi), p = S.players[n];
    H.cards.mid = c; H.bet = bet; H.stage = 'result';
    if (r > lo && r < hi) { p.chips += bet; H.pot -= bet; H.res = 'win'; H.msg = n + ' wins ' + bet }
    else if (r == lo || r == hi) { p.chips -= 2 * bet; H.pot += 2 * bet; H.res = 'post'; H.msg = n + ' hit the post: pays ' + 2 * bet }
    else { p.chips -= bet; H.pot += bet; H.res = 'lose'; H.msg = n + ' loses ' + bet }
    if (H.pot <= 0) { H.msg = n + ' takes the whole pot!'; H.show = 1; afterGame(); return }
    H.nextAt = now() + RESULT;
  }
  // standing up mid-game: out of the game (ante stays in the pot), seat frees when it ends
  function btsForfeit(n) {
    const H = S.hand, i = S.seats.indexOf(n), wasTurn = H.turn === i; H.out[i] = 1; H.msg = n + ' leaves the game';
    const left = btsIn();
    if (left.length == 1) { const w = S.seats[left[0]]; S.players[w].chips += H.pot; H.msg += ' · ' + w + ' takes the pot of ' + H.pot; H.pot = 0; H.show = 1; afterGame(); return }
    if (wasTurn) btsNext();
  }

  // ---------- Screw Your Neighbor ----------
  // One ante buys into the game and 4 lives. Each round everyone alive gets one card. Starting left of the
  // dealer, each player keeps it or swaps with the next player on their left; the last player (the dealer,
  // while alive) may swap with the top of the deck instead. An Ace can't be taken: a swap with an Ace is
  // refused and the Ace is shown. Everyone tied for the lowest card loses a life. Last one with lives wins.
  const rank = c => c % 13;
  // Screw Your Neighbor: holding an Ace there's nothing to decide, so that turn is just 5 seconds
  const holdsAce = i => S.hand.g == 'syn' && S.hand.cards && i in S.hand.cards && rank(S.hand.cards[i]) == ACE;
  const alive = () => S.hand.ps.filter(i => S.hand.lives[i] > 0);
  function startSyn(nb, only) {
    const ps = []; for (let k = 1; k <= SEATS; k++) { const i = (nb + k) % SEATS, n = S.seats[i]; if (n && S.players[n].chips >= S.ante && (!only || only.includes(n))) ps.push(i) }
    if (ps.length < 2) return 'Need at least 2 seated players who can cover the ante of ' + S.ante;
    S.btn = S.dealer = nb; S.dealDl = 0;
    const lives = {}; ps.forEach(i => { S.players[S.seats[i]].chips -= S.ante; lives[i] = LIVES });
    // a pot left over from a game where everyone went out is added in
    const pot = ps.length * S.ante + (S.carry || 0); S.carry = 0;
    S.hand = {g: 'syn', ps, btn: nb, lives, pot, ante: S.ante, d: shuffle(), cards: {}, shown: {}, low: [],
      round: 0, turn: -1, nact: 0, stage: 'play', done: 0, show: 0, msg: ''};
    synRound();
  }
  function synRound() {
    const H = S.hand, al = alive();
    // not enough cards left to deal everyone (plus one for a swap with the deck): fresh shuffled deck
    const re = H.d.length < al.length + 1; if (re) H.d = shuffle();
    H.cards = {}; H.shown = {}; H.low = []; H.notes = {}; H.stage = 'play'; H.round++; H.nextAt = 0;
    al.forEach(i => { H.cards[i] = H.d.pop(); if (S.players[S.seats[i]].bot && rank(H.cards[i]) == ACE && random() < .5) H.shown[i] = 1 });
    H.turn = al[0]; H.msg = 'Round ' + H.round + (re ? ' · deck reshuffled' : '');
  }
  function synAct(n, a) {
    const H = S.hand, i = S.seats.indexOf(n);
    if (!(H.lives[i] > 0) || H.stage != 'play') return 'Not your turn';
    if (a == 'show') { if (rank(H.cards[i]) == ACE) { H.shown[i] = 1; H.msg = n + ' shows an Ace' } return }
    if (H.turn !== i) return 'Not your turn';
    const al = alive(), k = al.indexOf(i);
    if (a == 'swap' && rank(H.cards[i]) == ACE) return "You have an Ace: no need to swap";
    if (a == 'swap' && k < al.length - 1 && H.shown[al[k + 1]]) return S.seats[al[k + 1]] + " has an Ace showing: you can't swap";
    // what each player gave and got this round; only those two players ever see it
    const notes = H.notes = H.notes || {}, note = (who, x) => (notes[who] = notes[who] || []).push(x);
    if (a == 'swap' && k == al.length - 1) {
      const gave = H.cards[i]; H.cards[i] = H.d.pop(); delete H.shown[i]; H.msg = n + ' swaps with the deck';
      note(i, {k: 'deck', gave, got: H.cards[i]});
    }
    else if (a == 'swap') {
      const j = al[k + 1], m = S.seats[j];
      if (rank(H.cards[j]) == ACE) {
        H.shown[j] = 1; H.msg = n + ' tried to swap with ' + m + ', who has an Ace!';
        note(i, {k: 'blocked', to: m}); note(j, {k: 'kept', from: n});
      }
      else {
        note(i, {k: 'gave', to: m, gave: H.cards[i], got: H.cards[j]}); note(j, {k: 'took', from: n, gave: H.cards[j], got: H.cards[i]});
        [H.cards[i], H.cards[j]] = [H.cards[j], H.cards[i]]; H.msg = n + ' swaps with ' + m;
        if (H.shown[i]) { delete H.shown[i]; H.shown[j] = 1 } // a shown Ace stays face up
      }
    } else H.msg = n + ' keeps';
    H.nact++;
    if (k < al.length - 1) H.turn = al[k + 1]; else synReveal();
  }
  function synReveal() {
    const H = S.hand, al = alive(), lo = Math.min(...al.map(i => rank(H.cards[i]))), losers = al.filter(i => rank(H.cards[i]) == lo);
    H.stage = 'reveal'; H.turn = -1; H.low = losers;
    losers.forEach(i => H.lives[i]--); H.msg = losers.map(i => S.seats[i]).join(', ') + (losers.length > 1 ? ' each lose' : ' loses') + ' a life';
    synCheckWin() || (H.nextAt = now() + REVEAL);
  }
  function synCheckWin() {
    const H = S.hand, al = alive(); if (!al.length) return synEveryoneOut();
    if (al.length != 1) return false;
    const w = S.seats[al[0]]; S.players[w].chips += H.pot; H.msg += ' · ' + w + ' wins ' + H.pot; H.show = 1; afterGame(); return true;
  }
  // the last players all tied and went out together: no winner. The pot carries over, and everyone who
  // can cover the ante gets 30s to ante again; with 2 or more in, the same dealer starts a new game.
  function synEveryoneOut() {
    const H = S.hand; S.carry = (S.carry || 0) + H.pot; H.show = 1;
    H.msg += ' · Everyone is out! The pot of ' + S.carry + ' carries over';
    afterGame(true);
    const who = S.seats.filter(n => n && S.players[n].chips >= H.ante);
    S.again = {ante: H.ante, btn: H.btn, until: now() + AGAIN, who, yes: {}, no: {}};
    who.filter(n => S.players[n].bot).forEach(n => againAnswer(n, true)); // bots always go again
    return true;
  }
  function againAnswer(n, yes) {
    const A = S.again; if (!A || !A.who.includes(n)) return; delete A.yes[n]; delete A.no[n]; (yes ? A.yes : A.no)[n] = 1;
    if (A.who.every(x => A.yes[x] || A.no[x])) againResolve();
  }
  function againResolve() {
    const A = S.again, ins = Object.keys(A.yes).filter(n => S.seats.includes(n) && S.players[n].chips >= A.ante); S.again = null;
    if (ins.length >= 2) { S.ante = A.ante; S.game = 'syn'; const snap = takeSnap(); startSyn(A.btn, ins); S.snap = snap; S.hand.msg = 'New game! The pot carried over · ' + S.hand.msg }
    else if (S.hand) S.hand.msg = 'Not enough players to go again: the pot of ' + S.carry + ' waits for the next Screw Your Neighbor game';
  }
  // standing up mid-game forfeits: out of the game now, ante stays in the pot, seat frees when the game ends
  function synForfeit(n) {
    const H = S.hand, i = S.seats.indexOf(n), al0 = alive(), k = al0.indexOf(i), wasTurn = H.stage == 'play' && H.turn === i;
    H.lives[i] = 0; delete H.cards[i]; delete H.shown[i]; H.msg = n + ' leaves the game';
    if (synCheckWin()) return;
    if (wasTurn) { const nx = al0.slice(k + 1).find(j => H.lives[j] > 0); if (nx === undefined) synReveal(); else H.turn = nx }
  }

  // ---------- requests ----------
  /** A player's own request. Returns an error message, or undefined. */
  function player(n, m) {
    if (!S.players[n] && m.t != 'sit') return;
    const seated = S.seats.includes(n);
    if (m.t == 'sit') {
      if (seated || S.pend[n] || S.queue.includes(n)) return;
      S.players[n] = S.players[n] || {chips: 0};
      if (openSeats() > 0) S.pend[n] = 1; else S.queue.push(n);
    }
    else if (m.t == 'unsit') { delete S.pend[n]; S.queue = S.queue.filter(x => x != n) }
    else if (m.t == 'stand') { if (!seated) return; standOrLeave(n) }
    else if (m.t == 'buy') { if (!seated) return; delete S.bust[n]; S.buy[n] = 1 }
    else if (m.t == 'deal') {
      if (S.seats[S.dealer] !== n) return "You're not the dealer";
      const keep = [S.sb, S.bb, S.ante];
      if (S.game == 'syn' || S.game == 'bts') { const an = m.ante == null ? S.ante : int(m.ante), e0 = anteError(an); if (e0) return e0; S.ante = an }
      else { const bb = m.bb == null ? S.bb : int(m.bb), e0 = blindError(bb); if (e0) return e0; S.sb = bb / 2; S.bb = bb }
      const e = startHand(); if (e) { [S.sb, S.bb, S.ante] = keep; return e }
    }
    else if (m.t == 'again') { if (!S.again) return; againAnswer(n, !!m.yes) }
    else if (m.t == 'game') {
      if (S.seats[S.dealer] !== n || live()) return "Only the dealer can change the game, between hands";
      const g = GAMES[m.game]; if (!g || !g.ready) return "That game isn't available yet";
      S.game = m.game;
    }
    else if (m.t == 'act') {
      if (!live()) return 'Not your turn';
      if (syn()) { const e = synAct(n, m.a); if (e) return e }
      else if (bts()) { const e = btsAct(n, m.a, m.amt); if (e) return e }
      else { if (S.seats[S.hand.turn] !== n) return 'Not your turn'; S.players[n].miss = 0; act(n, m.a, m.amt) }
    }
    else return;
    changed();
  }
  /** A host-panel action. Returns an error message, or undefined. */
  function host(m) {
    const n = m.name, p = S.players[n];
    if (['seat', 'noseat', 'give', 'nobuy', 'adj', 'rmbot', 'kick'].includes(m.op) && !p) return 'No such player';
    switch (m.op) {
      case 'start': { const e = startHand(); if (e) return e; break }
      case 'bot': {
        const s = freeSeat(); if (s < 0) return 'Table is full';
        let k = 1; while (S.players['Bot ' + k]) k++;
        S.players['Bot ' + k] = {chips: 1000, bot: 1}; S.seats[s] = 'Bot ' + k; S.last = s; break;
      }
      case 'rmbot': { if (!p.bot) return 'Not a bot'; if (live()) return 'Wait until this hand ends'; stand(n); delete S.players[n]; break }
      case 'seat': {
        if (!S.pend[n]) return; const add = m.add == null || m.add === '' ? (p.chips > 0 ? 0 : 1000) : int(m.add), s = freeSeat();
        if (!(add >= 0)) return 'Enter a chip amount'; if (s < 0) return 'Table is full'; if (p.chips + add <= 0) return 'Give them some chips first';
        p.chips += add; hostChips(n, add); S.seats[s] = n; S.last = s; delete S.pend[n]; break;
      }
      case 'noseat': delete S.pend[n]; break;
      case 'give': { const add = int(m.add); if (!(add > 0)) return 'Enter a chip amount'; p.chips += add; hostChips(n, add); delete S.buy[n]; break }
      case 'nobuy': delete S.buy[n]; if (p.chips <= 0 && !inLiveHand(n) && S.seats.includes(n)) stand(n); break;
      case 'adj': { const x = int(m.x); if (!x) return; if (inLiveHand(n)) return 'Wait until this hand ends'; const was = p.chips; p.chips = x < 0 ? Math.max(p.chips + x, Math.min(p.chips, 0)) : p.chips + x; hostChips(n, p.chips - was); break }
      case 'cancel': { const e = cancelGame(); if (e) return e; break }
      case 'kick': standOrLeave(n); break;
      case 'blinds': { const bb = int(m.bb), e = blindError(bb); if (e) return e; S.sb = bb / 2; S.bb = bb; break }
      case 'pause': S.paused = m.on ? 1 : 0; break;
      default: return;
    }
    changed();
  }
  /** Timers: bust deadlines and bot moves. Call a few times a second. */
  function tick() {
    if (S.frozenAt) return;
    let ch = 0; const t = now();
    for (const n in S.bust) if (t >= S.bust[n]) { stand(n); ch = 1 }
    const H = S.hand;
    if (botAt && t >= botAt && live() && syn()) {
      // bots keep an 8 or better, and never try to swap into an Ace that's showing
      const al = alive(), k = al.indexOf(H.turn), nb = al[k + 1];
      synAct(S.seats[H.turn], rank(H.cards[H.turn]) >= 6 || (nb !== undefined && H.shown[nb]) ? 'keep' : 'swap'); ch = 1;
    }
    else if (botAt && t >= botAt && live() && bts()) {
      // bots bet on a wide spread, more on a wider one
      if (H.stage == 'bet') {
        const gap = rank(H.cards.hi) - rank(H.cards.lo) - 1, bet = Math.min(H.pot, gap >= 9 ? 500 : gap >= 7 ? 200 : 100);
        btsAct(S.seats[H.turn], gap >= 6 ? 'bet' : 'pass', bet); ch = 1;
      }
    }
    else if (botAt && t >= botAt && live() && holdem()) {
      const n = S.seats[H.turn], p = S.players[n], need = H.cur - H.bet[H.turn];
      const opts = need > 0 ? ['fold', 'call', 'raise'] : ['call', 'raise'], a = opts[random() * opts.length | 0];
      act(n, a, H.cur + H.minR * (1 + (random() * 4 | 0)) + (random() < .1 ? p.chips : 0)); ch = 1;
    }
    if (S.again && t >= S.again.until) { againResolve(); ch = 1 }
    // Screw Your Neighbor: after the reveal, the next round deals itself
    if (syn() && live() && S.hand.stage == 'reveal' && t >= S.hand.nextAt) { synRound(); ch = 1 }
    // Between the Sheets: after a result (or a no-bet pause), the next player is dealt in
    if (bts() && live() && S.hand.stage != 'bet' && t >= S.hand.nextAt) { btsNext(); ch = 1 }
    // dealer didn't deal in time: the deal passes to the left
    if (S.dealDl && t >= S.dealDl && canDeal()) {
      const from = S.seats[S.dealer]; S.dealer = nextEligible(S.dealer); S.dealDl = 0;
      if (S.hand) S.hand.msg = from + ' passed the deal to ' + S.seats[S.dealer];
      ch = 1;
    }
    // a bot dealer deals on its own, as long as a person is playing
    // (it thinks for 5 seconds from the moment it could deal)
    const botDeal = canDeal() && t >= S.wait && S.dealer >= 0 && S.players[S.seats[S.dealer]].bot && S.seats.some(n => n && !S.players[n].bot && S.players[n].chips > 0);
    if (!botDeal) botDealAt = 0; else if (!botDealAt) botDealAt = t + BOT_DELAY; else if (t >= botDealAt && !startHand()) { botDealAt = 0; ch = 1 }
    // turn clock ran out: check if possible, else fold; the third miss in a row stands them up
    if (live() && syn() && S.hand.dl && t >= S.hand.dl) {
      const H = S.hand, n = S.seats[H.turn], ace = holdsAce(H.turn); synAct(n, 'keep'); if (H.stage == 'play') H.msg = n + (ace ? ' keeps' : ' keeps (out of time)'); ch = 1;
    }
    else if (live() && bts() && S.hand.stage == 'bet' && S.hand.dl && t >= S.hand.dl) {
      const H = S.hand, n = S.seats[H.turn]; btsAct(n, 'pass'); H.msg = n + ' passes (out of time)'; ch = 1;
    }
    else if (live() && holdem() && S.hand.dl && t >= S.hand.dl) {
      const H = S.hand, n = S.seats[H.turn], p = S.players[n], need = H.cur - H.bet[H.turn];
      p.miss = (p.miss || 0) + 1; const out = p.miss >= MISSES;
      act(n, need > 0 ? 'fold' : 'call');
      if (out) standOrLeave(n);
      if (live()) H.msg = n + (out ? ' timed out 3 times and will stand up' : (need > 0 ? ' folds' : ' checks') + ' (out of time)');
      ch = 1;
    }
    if (ch) changed();
  }
  /** Add a person's name to the history. */
  function remember(n) { if (!S.known[n] || S.known[n] < now() - 60000) { S.known[n] = now(); changed() } }
  /** Delete a name from the history, with its saved chips. Returns an error message, or undefined. */
  function forget(n) {
    if (!S.known[n] && !S.players[n]) return 'No such name';
    if (S.seats.includes(n) || S.pend[n]) return n + ' is at the table: stand them up first';
    delete S.known[n]; delete S.players[n]; S.queue = S.queue.filter(x => x != n); changed();
  }
  /** Start over: no players, no chips, no history. */
  function reset() { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, fresh()); botAt = 0; changed() }
  /** What one viewer may see: no deck, and hole cards only for themselves (and live hands at showdown). */
  function view(name) {
    const H = S.hand; let hand = null;
    if (H && H.g == 'bts') { const {d, ...rest} = H; hand = {...rest, deckN: d.length} }
    else if (H && H.g == 'syn') {
      // your own card, shown Aces, and everything once the round is revealed
      const my = name ? S.seats.indexOf(name) : -1, cards = {};
      for (const i in H.cards) cards[i] = +i === my || H.shown[i] || H.stage == 'reveal' ? H.cards[i] : null;
      const al = H.done ? [] : alive(), k = al.indexOf(H.turn);
      const {d, notes, ...rest} = H; hand = {...rest, cards, notes: (notes || {})[my] || [], deckN: d.length, nb: k < 0 ? -1 : k < al.length - 1 ? al[k + 1] : -1};
    }
    else if (H) {
      const my = name ? S.seats.indexOf(name) : -1, h = {};
      for (const i of H.ps) h[i] = i === my || (H.show && !H.fold[i]) ? H.h[i] : H.h[i].map(() => null);
      const {d, ...rest} = H; hand = {...rest, h};
    }
    const players = {}; for (const n in S.players) players[n] = {chips: S.players[n].chips, bot: !!S.players[n].bot};
    return {players, seats: S.seats, pend: S.pend, leave: S.leave, bust: S.bust, buy: S.buy, wait: S.wait, hand,
      btn: S.btn, dealer: S.dealer, dealDl: S.dealDl, sb: S.sb, bb: S.bb, ante: S.ante, game: S.game, gameName: GAMES[S.game].name,
      games: Object.entries(GAMES).map(([id, g]) => ({id, name: g.name, blurb: g.blurb, ready: !!g.ready})), n: S.n,
      queue: S.queue, paused: S.frozenAt || 0, carry: S.carry || 0, again: S.again, hold: holdReason(),
      canUndo: !!S.snap, known: Object.keys(S.known).sort((a, b) => S.known[b] - S.known[a])};
  }
  return {state: () => S, view, player, host, tick, remember, forget, reset};
}

module.exports = {createTable, best, s5, category, WAIT, BUST, TURN, SEATS};
