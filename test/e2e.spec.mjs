// End-to-end: real server, real browsers. Run: node test/e2e.spec.mjs
import {chromium} from 'playwright';
import {spawn} from 'child_process';
import {mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
const root = new URL('..', import.meta.url).pathname, data = join(mkdtempSync(join(tmpdir(), 'poker-')), 'table.json');
const PORT = 3000 + Math.floor(Math.random() * 1000), URL_ = `http://localhost:${PORT}/`, KEY = 'K+Kj/SW=x9';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ };
let srv;
async function start() {
  srv = spawn('node', ['server.js'], {cwd: root, env: {...process.env, PORT, HOST_KEY: KEY, DATA_FILE: data}, stdio: ['ignore', 'pipe', 'inherit']});
  await new Promise(r => srv.stdout.on('data', d => String(d).includes('Poker Night on') && r()));
}
async function stop() { await new Promise(r => setTimeout(r, 500)); srv.kill(); await new Promise(r => srv.on('exit', r)) }
await start();
const browser = await chromium.launch({executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
async function player(name, hash = '') {
  const ctx = await browser.newContext(), p = await ctx.newPage(), errs = [], frames = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('websocket', ws => ws.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)) } catch (e) {} }));
  await p.goto(URL_ + hash);
  if (name) { await p.fill('#nm', name); await p.click('text=Join') }
  return {ctx, p, errs, frames};
}
const errText = async p => (await p.textContent('#note')) || '';

// host link: host panel, no sign-in
const H = await player('Hana', '#host=' + KEY);
await H.p.waitForSelector('text=+ Bot');
ok(!(await H.p.url()).includes(KEY), 'host key is removed from the address bar');
await H.p.click('text=+ Bot');

// a friend joins with just the link and a name
const P = await player('Pat');
await P.p.waitForSelector('button:text-is("Sit Down")');
ok(!(await P.p.$('text=+ Bot')), 'players do not get host controls');
await P.p.click('button:text-is("Sit Down")');
await H.p.waitForSelector('text=Seat requests');
await H.p.click('[data-a=ok]');
await P.p.waitForSelector('button:text-is("Stand Up")');
ok(true, 'host approves a seat; player sees Stand Up');

// someone else can't take a connected player's name, and can't use host actions
const X = await player('Pat');
await X.p.waitForTimeout(300);
ok((await errText(X.p)).includes('already playing'), 'a connected player\'s name cannot be taken');
await X.p.evaluate(() => { const w = new WebSocket('ws://' + location.host + '/ws'); w.onopen = () => w.send(JSON.stringify({t: 'host', op: 'bot'})); });
await X.p.waitForTimeout(300);
ok(Object.keys(P.frames.at(-1).s.players).length == 2, 'non-host cannot run host actions');
await X.ctx.close();

// deal: Pat gets their own cards and nobody else's
await H.p.click('text=Deal next hand');
await P.p.waitForSelector('text=Peek');
const leaks = P.frames.filter(f => f.t == 'state' && f.s.hand).some(f => {
  const s = f.s, my = s.seats.indexOf('Pat');
  return 'd' in s.hand || Object.entries(s.hand.h).some(([i, cs]) => +i != my && !s.hand.show && cs.some(c => c != null));
});
ok(!leaks, 'no state message contains the deck or another player\'s hole cards');
const mine = P.frames.at(-1).s.hand.h[P.frames.at(-1).s.seats.indexOf('Pat')];
ok(mine.every(c => Number.isInteger(c)), 'player receives their own two cards');
ok((await P.p.$$('#main .c.lg.b')).length == 2, 'own cards are face down until Peek');
await P.p.click('text=Peek');
ok((await P.p.$$('#main .c.lg.b')).length == 0, 'Peek shows them');

// Pat folds when it's their turn; the hand ends (heads-up vs the bot) or continues
await P.p.waitForSelector('[data-a=fold]', {timeout: 10000}).then(() => P.p.click('[data-a=fold]')).catch(() => {});
await H.p.waitForFunction(() => document.querySelector('[data-a=start]')?.textContent.startsWith('Deal in'), null, {timeout: 15000});
ok(await H.p.isDisabled('[data-a=start]'), 'Deal counts down after the hand');
const chips = P.frames.at(-1).s.players.Pat.chips;

// restart the server: chips and the device's name survive
await stop(); await start();
await P.p.reload(); await P.p.waitForSelector('button:text-is("Stand Up")');
ok(P.frames.at(-1).s.players.Pat.chips == chips, 'chips survive a server restart');
ok((await P.p.textContent('#main')).includes('Pat'), 'player is remembered on their device');
await H.p.waitForSelector('text=+ Bot', {timeout: 10000});
ok(true, 'host reconnects after restart');

ok(!H.errs.length && !P.errs.length, 'no page errors ' + H.errs.concat(P.errs).join('|'));
await browser.close(); await stop();
console.log(fails ? fails + ' failing' : 'all passed'); process.exit(fails ? 1 : 0);
