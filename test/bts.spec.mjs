// End-to-end: Between the Sheets in real (phone-sized) browsers. Run: node test/bts.spec.mjs
import {chromium} from 'playwright';
import {spawn} from 'child_process';
import {mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
const root = new URL('..', import.meta.url).pathname, data = join(mkdtempSync(join(tmpdir(), 'poker-')), 'table.json');
const PORT = 5000 + Math.floor(Math.random() * 1000), URL_ = `http://localhost:${PORT}/`;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ };
const srv = spawn('node', ['server.js'], {cwd: root, env: {...process.env, PORT, HOST_KEY: 'k', DATA_FILE: data}, stdio: ['ignore', 'pipe', 'inherit']});
process.on('exit', () => srv.kill());
await new Promise(r => srv.stdout.on('data', d => String(d).includes('Poker Night on') && r()));
const browser = await chromium.launch({executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
async function player(name) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}), p = await ctx.newPage(), errs = [], frames = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('websocket', ws => ws.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)) } catch (e) {} }));
  await p.goto(URL_); await p.fill('#nm', name); await p.click('text=Join');
  return {p, errs, last: () => frames.filter(f => f.t == 'state').at(-1)};
}
const H = await player('Hana'), P = await player('Pat');
await H.p.click('button:text-is("Sit Down")'); await H.p.click('[data-a=ok][data-v="Hana"]');
await P.p.click('button:text-is("Sit Down")'); await H.p.click('[data-a=ok][data-v="Pat"]');

await H.p.waitForSelector("text=You're the dealer");
await H.p.click('text=Change game');
ok((await H.p.textContent('[data-a=setgame][data-v=bts]')).includes('Between the Sheets'), 'Between the Sheets is on the game list');
await H.p.click('[data-a=setgame][data-v=bts]');
await H.p.fill('#dan', '200'); await H.p.click('[data-a=deal]');
await P.p.waitForFunction(() => document.querySelector('#gt').textContent.includes('Between the Sheets'));
await P.p.waitForSelector('.deck b');
const s = P.last().s;
ok(s.hand.g == 'bts' && s.hand.pot == 400 && s.players.Pat.chips == 800, 'ante of 200 each makes the pot');
ok(await P.p.textContent('.deck b') == String(s.hand.deckN), 'cards left are shown on the deck');
ok(await P.p.$$eval('.mid .c:not(.b):not(.e)', e => e.length) == 2, 'your two cards are face up in the middle');

// crafted turns on Pat's screen, for the cases a random deal may not give us
async function pretend(edit) {
  const f = JSON.parse(JSON.stringify(P.last())), h = f.s.hand, my = f.s.seats.indexOf('Pat');
  Object.assign(h, {done: 0, turn: my, out: {}, nextAt: f.now + 10000, dl: f.now + 30000, res: '', why: ''}); edit(h); f.s.n += 1000;
  await P.p.evaluate(m => ws.onmessage({data: JSON.stringify(m)}), f);
}
await pretend(h => Object.assign(h, {stage: 'bet', pot: 400, cards: {lo: 1, hi: 10, mid: null}}));
ok((await P.p.textContent('#main')).includes('Bet the next card lands between 3♠ and Q♠'), 'your turn: bet between your two cards');
ok(await P.p.getAttribute('#bta', 'max') == '400' && await P.p.getAttribute('#bta', 'step') == '100', 'bets in steps of 100, up to the pot');
await P.p.fill('#bta', '950'); await P.p.click('.note-ok');
ok(await P.p.inputValue('#bta') == '400', "can't type more than the pot");
await P.p.click('[data-a=btdn]'); await P.p.click('[data-a=btdn]');
ok(await P.p.inputValue('#bta') == '200', '− steps down by 100');
ok(await P.p.$eval('#main .p', e => e.classList.contains('turn')), 'panel turns red on your turn');
await pretend(h => Object.assign(h, {stage: 'skip', why: 'next-door cards', cards: {lo: 5, hi: 6, mid: null}}));
ok(/No bet: next-door cards\. Next player in \d+s/.test(await P.p.textContent('#main')), 'next-door cards: no bet, with a countdown');
await pretend(h => Object.assign(h, {stage: 'skip', why: 'same value', cards: {lo: 5, hi: 18, mid: null}}));
ok((await P.p.textContent('#main')).includes('No bet: same value'), 'a pair: no bet');

// the rules tab
await P.p.click('[data-a=rules]'); await P.p.click('[data-a=rulesgame][data-v=bts]');
ok((await P.p.textContent('#rules')).includes('Hitting the post'), 'rules: Between the Sheets');
await P.p.click('text=Back to the table');

ok(!H.errs.length && !P.errs.length, 'no page errors ' + H.errs.concat(P.errs).join('|'));
await browser.close();
console.log(fails ? fails + ' failing' : 'all passed'); process.exit(fails ? 1 : 0);
