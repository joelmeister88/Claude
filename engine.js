'use strict';
// Poker table engine: pure game logic, no networking. The server owns one table,
// feeds it player/host requests, and sends each viewer view(name) — which never
// includes the deck or anyone else's hole cards.
const crypto = require('crypto');

const GAMES = {holdem: {name: "Texas Hold'em", hole: 2}};
const HN = ['High card', 'Pair', 'Two pair', 'Trips', 'Straight', 'Flush', 'Full house', 'Quads', 'Straight flush'];
const WAIT = 10000, BUST = 30000, TURN = 30000, DEAL = 30000, MISSES = 3, BOT_DELAY = 1300, SEATS = 12;

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

const fresh = () => ({players: {}, seats: Array(SEATS).fill(''), pend: {}, leave: {}, bust: {}, buy: {}, wait: 0,
  hand: null, btn: -1, dealer: -1, dealDl: 0, sb: 5, bb: 10, game: 'holdem', n: 0, last: -1, known: {}});
const int = v => { const x = Math.floor(+v); return Number.isFinite(x) ? x : NaN };

/**
 * opts: now() clock, random() for bots, shuffle() -> 52-card deck (last card dealt first),
 * onChange() after every mutation (persist + broadcast).
 */
function createTable(saved, {now = Date.now, random = Math.random, shuffle = cryptoShuffle, onChange = () => {}} = {}) {
  const S = Object.assign(fresh(), saved || {});
  // a restart shouldn't time out whoever was mid-decision
  if (S.hand && !S.hand.done) S.hand.dl = now() + TURN;
  S.dealDl = 0;
  // name history: everyone who has played here, bots excluded
  for (const n in S.players) if (!S.players[n].bot && !S.known[n]) S.known[n] = 1;
  let botAt = 0;

  function changed() {
    S.n++; tidy(); dealerUpkeep();
    const H = S.hand, p = H && !H.done && S.players[S.seats[H.turn]];
    botAt = p && p.bot ? now() + BOT_DELAY : 0;
    // each new decision gets a fresh 30s turn clock (bots move on their own timer)
    if (H && !H.done) { const key = H.turn + ':' + (H.nact || 0); if (H.dlKey !== key) { H.dlKey = key; H.dl = p && !p.bot ? now() + TURN : 0 } }
    onChange();
  }
  const freeSeat = () => { for (let k = 1; k <= SEATS; k++) { const i = ((S.last ?? -1) + k + SEATS) % SEATS; if (!S.seats[i]) return i } return -1 };
  const live = () => S.hand && !S.hand.done;
  const inLiveHand = n => { const i = S.seats.indexOf(n); return live() && S.hand.ps.includes(i) && !S.hand.fold[i] };
  // seated players at 0 chips who haven't stood up hold the next deal
  const owed = () => S.seats.filter(n => n && S.players[n].chips <= 0);
  function tidy() {
    for (const n of Object.keys(S.bust).concat(Object.keys(S.buy)))
      if (!S.seats.includes(n) || S.players[n].chips > 0) { delete S.bust[n]; delete S.buy[n] }
  }
  // ---------- the dealer (button) deals the next hand and picks the blinds ----------
  const eligible = i => { const n = S.seats[i]; return !!n && S.players[n].chips > 0 && !S.leave[n] };
  function nextEligible(from) { for (let k = 1; k <= SEATS; k++) { const i = (from + k + SEATS) % SEATS; if (eligible(i)) return i } return -1 }
  const canDeal = () => !live() && !owed().length && S.seats.filter((n, i) => eligible(i)).length >= 2;
  // keep `dealer` on a seat that can deal, and run its 30s clock once dealing is possible (after the 10s pause)
  function dealerUpkeep() {
    if (live()) { S.dealDl = 0; return }
    if (S.dealer < 0 || !eligible(S.dealer)) { S.dealer = nextEligible(S.dealer >= 0 ? S.dealer : S.btn); S.dealDl = 0 }
    if (!canDeal()) S.dealDl = 0;
    else if (!S.dealDl) S.dealDl = Math.max(now(), S.wait) + DEAL;
  }
  function stand(n) { const i = S.seats.indexOf(n); if (i >= 0) S.seats[i] = ''; delete S.leave[n]; delete S.bust[n]; delete S.buy[n]; if (S.players[n]) S.players[n].miss = 0 }
  // standing up mid-hand: fold when the action reaches them, leave the seat when the hand ends
  function standOrLeave(n) { if (inLiveHand(n)) { S.leave[n] = 1; autoFold() } else stand(n) }

  // ---------- betting ----------
  function nxt(f) { const H = S.hand, L = H.ps.length, o = H.ps.indexOf(f); for (let k = 1; k <= L; k++) { const s = H.ps[(o + k) % L]; if (!H.fold[s] && !H.allin[s]) return s } return -1 }
  function post(i, a) { const H = S.hand, p = S.players[S.seats[i]]; a = Math.max(0, Math.min(a, p.chips)); p.chips -= a; H.bet[i] += a; H.tot[i] += a; if (p.chips == 0) H.allin[i] = 1 }
  function startHand() {
    if (live()) return 'Hand in progress';
    const o = owed(); if (o.length) return 'Waiting on ' + o.join(', ') + ' to get chips or stand up';
    if (now() < S.wait) return 'Next hand can be dealt in a moment';
    const g = GAMES[S.game], nb = S.dealer >= 0 && eligible(S.dealer) ? S.dealer : nextEligible(S.btn);
    const ps = []; for (let k = 1; k <= SEATS; k++) { const i = (nb + k) % SEATS, n = S.seats[i]; if (n && S.players[n].chips > 0) ps.push(i) }
    if (ps.length < 2) return 'Need at least 2 seated players with chips';
    S.btn = S.dealer = nb; S.dealDl = 0; const d = shuffle();
    const h = {}, bet = {}, tot = {}; ps.forEach(i => { h[i] = Array.from({length: g.hole}, () => d.pop()); bet[i] = 0; tot[i] = 0 });
    const H = S.hand = {ps, btn: nb, d, board: [], h, bet, tot, fold: {}, allin: {}, acted: {}, stage: 0, cur: S.bb, minR: S.bb, turn: -1, done: 0, show: 0, msg: 'New hand'};
    const hu = ps.length == 2, sb = hu ? ps[1] : ps[0], bb = hu ? ps[0] : ps[1], first = hu ? ps[1] : ps[2 % ps.length];
    post(sb, S.sb); post(bb, S.bb);
    H.turn = H.allin[first] ? nxt(first) : first;
    if (H.turn < 0) adv(); // everyone all-in from the blinds: run the board out
    autoFold();
  }
  function endHand() {
    const t = now(); S.hand.done = 1; S.wait = t + WAIT; Object.keys(S.leave).forEach(stand);
    S.seats.forEach(n => { if (n && S.players[n].chips <= 0) { if (S.players[n].bot) stand(n); else if (!S.buy[n]) S.bust[n] = t + BUST } });
    S.dealer = nextEligible(S.hand.btn); S.dealDl = 0; // the button moves one to the left
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
        if (to < H.cur + H.minR && to < mx) to = Math.min(H.cur + H.minR, mx);
        if (to - H.cur >= H.minR) H.minR = to - H.cur;
        H.cur = to; H.acted = {}; post(t, to - b); H.msg = n + (H.allin[t] ? ' is all-in ' : ' raises to ') + to;
      }
    }
    H.acted[t] = 1; H.nact = (H.nact || 0) + 1; adv(); autoFold();
  }
  function autoFold() { const H = S.hand; if (live() && S.leave[S.seats[H.turn]]) act(S.seats[H.turn], 'fold') }

  // ---------- requests ----------
  /** A player's own request. Returns an error message, or undefined. */
  function player(n, m) {
    if (!S.players[n] && m.t != 'sit') return;
    const seated = S.seats.includes(n);
    if (m.t == 'sit') { if (seated || S.pend[n]) return; S.players[n] = S.players[n] || {chips: 0}; S.pend[n] = 1 }
    else if (m.t == 'unsit') delete S.pend[n];
    else if (m.t == 'stand') { if (!seated) return; standOrLeave(n) }
    else if (m.t == 'buy') { if (!seated) return; delete S.bust[n]; S.buy[n] = 1 }
    else if (m.t == 'deal') {
      if (S.seats[S.dealer] !== n) return "You're not the dealer";
      const sb = m.sb == null ? S.sb : int(m.sb), bb = m.bb == null ? S.bb : int(m.bb);
      if (!(sb >= 1 && bb >= sb)) return 'Big blind must be at least the small blind';
      const keep = [S.sb, S.bb]; S.sb = sb; S.bb = bb;
      const e = startHand(); if (e) { [S.sb, S.bb] = keep; return e }
    }
    else if (m.t == 'act') { if (!live() || S.seats[S.hand.turn] !== n) return 'Not your turn'; S.players[n].miss = 0; act(n, m.a, m.amt) }
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
        p.chips += add; S.seats[s] = n; S.last = s; delete S.pend[n]; break;
      }
      case 'noseat': delete S.pend[n]; break;
      case 'give': { const add = int(m.add); if (!(add > 0)) return 'Enter a chip amount'; p.chips += add; delete S.buy[n]; break }
      case 'nobuy': delete S.buy[n]; if (p.chips <= 0 && !inLiveHand(n) && S.seats.includes(n)) stand(n); break;
      case 'adj': { const x = int(m.x); if (!x) return; if (inLiveHand(n)) return 'Wait until this hand ends'; p.chips = Math.max(0, p.chips + x); break }
      case 'kick': standOrLeave(n); break;
      case 'blinds': { const sb = int(m.sb), bb = int(m.bb); if (!(sb >= 1 && bb >= sb)) return 'Big blind must be at least the small blind'; S.sb = sb; S.bb = bb; break }
      default: return;
    }
    changed();
  }
  /** Timers: bust deadlines and bot moves. Call a few times a second. */
  function tick() {
    let ch = 0; const t = now();
    for (const n in S.bust) if (t >= S.bust[n]) { stand(n); ch = 1 }
    const H = S.hand;
    if (botAt && t >= botAt && live()) {
      const n = S.seats[H.turn], p = S.players[n], need = H.cur - H.bet[H.turn];
      const opts = need > 0 ? ['fold', 'call', 'raise'] : ['call', 'raise'], a = opts[random() * opts.length | 0];
      act(n, a, H.cur + H.minR * (1 + (random() * 4 | 0)) + (random() < .1 ? p.chips : 0)); ch = 1;
    }
    // dealer didn't deal in time: the deal passes to the left
    if (S.dealDl && t >= S.dealDl && canDeal()) {
      const from = S.seats[S.dealer]; S.dealer = nextEligible(S.dealer); S.dealDl = 0;
      if (S.hand) S.hand.msg = from + ' passed the deal to ' + S.seats[S.dealer];
      ch = 1;
    }
    // a bot dealer deals on its own, as long as a person is playing
    if (canDeal() && S.dealer >= 0 && S.players[S.seats[S.dealer]].bot && t >= S.wait + BOT_DELAY &&
        S.seats.some(n => n && !S.players[n].bot && S.players[n].chips > 0) && !startHand()) ch = 1;
    // turn clock ran out: check if possible, else fold; the third miss in a row stands them up
    if (live() && S.hand.dl && t >= S.hand.dl) {
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
    delete S.known[n]; delete S.players[n]; changed();
  }
  /** Start over: no players, no chips, no history. */
  function reset() { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, fresh()); botAt = 0; changed() }
  /** What one viewer may see: no deck, and hole cards only for themselves (and live hands at showdown). */
  function view(name) {
    const H = S.hand; let hand = null;
    if (H) {
      const my = name ? S.seats.indexOf(name) : -1, h = {};
      for (const i of H.ps) h[i] = i === my || (H.show && !H.fold[i]) ? H.h[i] : H.h[i].map(() => null);
      const {d, ...rest} = H; hand = {...rest, h};
    }
    const players = {}; for (const n in S.players) players[n] = {chips: S.players[n].chips, bot: !!S.players[n].bot};
    return {players, seats: S.seats, pend: S.pend, leave: S.leave, bust: S.bust, buy: S.buy, wait: S.wait, hand,
      btn: S.btn, dealer: S.dealer, dealDl: S.dealDl, sb: S.sb, bb: S.bb, game: S.game, gameName: GAMES[S.game].name, n: S.n,
      known: Object.keys(S.known).sort((a, b) => S.known[b] - S.known[a])};
  }
  return {state: () => S, view, player, host, tick, remember, forget, reset};
}

module.exports = {createTable, best, s5, category, WAIT, BUST, TURN, SEATS};
