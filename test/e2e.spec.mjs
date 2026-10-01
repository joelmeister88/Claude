// End-to-end: real server, real (phone-sized) browsers. Run: node test/e2e.spec.mjs
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
process.on('exit', () => srv && srv.kill()); // never leave a server running
const browser = await chromium.launch({executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
async function player(name, hash = '') {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}), p = await ctx.newPage(), errs = [], frames = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('websocket', ws => ws.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)) } catch (e) {} }));
  await p.goto(URL_ + hash);
  if (name) { await p.fill('#nm', name); await p.click('text=Join') }
  return {ctx, p, errs, frames, last: () => frames.filter(f => f.t == 'state').at(-1)};
}
const errText = async p => (await p.textContent('#note')) || '';

// the first person on the link is the host; the admin link also unlocks admin
const H = await player('Hana', '#host=' + encodeURIComponent(KEY).replace(/%2B/g, '+'));
await H.p.waitForSelector('text=+ Bot');
ok(true, 'first person to join is the host');
ok(await H.p.isVisible('text=Reset table'), 'admin link unlocks admin');
ok(!(await H.p.url()).includes('host='), 'admin key is removed from the address bar');
await H.p.click('text=+ Bot');

// a second person is just a player
const P = await player('Pat');
await P.p.waitForSelector('button:text-is("Sit Down")');
ok(!(await P.p.$('text=+ Bot')) && !(await P.p.$('text=Reset table')), 'second person gets no host or admin controls');
ok((await P.p.textContent('#lobby')).includes('Host: Hana'), 'everyone sees who the host is');
await P.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await P.p.click('text=Share');
ok(await P.p.evaluate(() => navigator.clipboard.readText()) == URL_, 'Share copies just the link');
await P.p.click('button:text-is("Sit Down")');
await H.p.waitForSelector('text=Seat requests');
ok(await H.p.$eval('#host .p', e => e.classList.contains('turn')), 'host panel turns red when someone wants a seat');
ok((await P.p.textContent('#main')).includes('Waiting for the host to seat Pat'), 'everyone sees the table is waiting on the host');
await H.p.click('[data-a=ok]');
await H.p.waitForFunction(() => !document.querySelector('#host .p').classList.contains('turn'));
await P.p.waitForSelector('button:text-is("Stand Up")');
ok(true, 'host approves a seat');

// can't take a connected player's name; can't use host actions without being host
const X = await player('');
ok(await X.p.isDisabled('button:has-text("Pat")'), 'names in use show as taken on the name screen');
await X.p.fill('#nm', 'Pat'); await X.p.click('text=Join'); await X.p.waitForTimeout(300);
ok((await errText(X.p)).includes('already playing'), 'a connected player\'s name cannot be taken');
await X.p.evaluate(() => { const w = new WebSocket('ws://' + location.host + '/ws'); w.onopen = () => w.send(JSON.stringify({t: 'host', op: 'bot'})); });
await X.p.waitForTimeout(300);
ok(Object.keys(P.last().s.players).length == 2, 'non-host cannot run host actions');
await X.ctx.close();

// Bot 1 holds the button and deals by itself; Pat gets only their own cards
await P.p.waitForSelector('text=Peek', {timeout: 20000});
ok(P.last().s.seats[P.last().s.hand.btn] == 'Bot 1', 'the bot dealer dealt');
ok(await P.p.$eval('.st .d', e => e.closest('.st').textContent.includes('Bot 1')), 'D marks the dealer\'s seat');
const leaks = P.frames.filter(f => f.t == 'state' && f.s.hand).some(f => {
  const s = f.s, my = s.seats.indexOf('Pat');
  return 'd' in s.hand || Object.entries(s.hand.h).some(([i, cs]) => +i != my && !s.hand.show && cs.some(c => c != null));
});
ok(!leaks, 'no state message contains the deck or another player\'s hole cards');
ok((await P.p.$$('#main .c.lg.b')).length == 2, 'own cards are face down until Peek');
await P.p.click('text=Peek');
ok((await P.p.$$('#main .c.lg.b')).length == 0, 'Peek shows them');
await P.p.click('text=Hide now');
ok((await P.p.$$('#main .c.lg.b')).length == 2, 'Hide now hides them right away');
// the bot may fold first; then Pat's turn comes in the next hand, which Pat deals
let turnChecked = false;
async function checkTurn() {
  ok(await P.p.$eval('#main .p', e => e.classList.contains('turn')), 'panel turns red on your turn');
  ok(/^(2\d|30)s$/.test(await P.p.textContent('.clock')), 'turn clock shows ~30s');
  ok(await P.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling');
  if (await P.p.$('#rt')) ok(await P.p.getAttribute('#rt', 'step') == String(P.last().s.bb), 'raise box steps by the big blind');
  turnChecked = true;
}
await P.p.waitForFunction(() => document.querySelector('[data-a=fold]') || document.querySelector('#main').textContent.includes("You're the dealer"), null, {timeout: 20000});
if (await P.p.$('[data-a=fold]')) { await checkTurn(); await P.p.click('[data-a=fold]') }

// the button moves left to Pat, who deals after the 10s pause with blinds of their choosing
await P.p.waitForSelector("text=You're the dealer");
ok(await P.p.isDisabled('[data-a=deal]') && /Deal in \d+s/.test(await P.p.textContent('[data-a=deal]')), 'dealer waits out the 10s pause');
ok((await H.p.textContent('#main')).includes('Pat deals next'), 'everyone sees who deals next');
ok((await P.p.textContent('#gt')).includes("Texas Hold'em"), 'game name is shown at the top');
await P.p.click('text=Change game');
const games = await P.p.$$eval('[data-a=setgame]', b => b.map(x => [x.textContent, x.disabled]));
ok(games[0][0].includes("Texas Hold'em") && games[1][0].includes('Screw Your Neighbor') && !games[1][1], "game list: Hold'em first, then Screw Your Neighbor");
await P.p.click('[data-a=setgame][data-v=holdem]');
await P.p.waitForSelector('#dbb');
await P.p.fill('#dbb', '37'); await P.p.click('#sbl');
ok(await P.p.inputValue('#dbb') == '40' && (await P.p.textContent('#sbl')).includes('20'), 'typed blind snaps to steps of 10; small blind is half');
await P.p.fill('#dbb', '3'); await P.p.click('#sbl');
ok(await P.p.inputValue('#dbb') == '10', 'blind is at least 10');
await P.p.click('[data-a=bbdn]'); ok(await P.p.inputValue('#dbb') == '10', 'minus stops at 10');
for (let k = 0; k < 4; k++) await P.p.click('[data-a=bbup]');
await P.p.click('[data-a=bbdn]');
ok(await P.p.inputValue('#dbb') == '40', 'plus and minus move by 10');
// host pauses: the dealer's clock stops for everyone
await H.p.click('[data-a=pause]');
await P.p.waitForSelector('text=Paused by the host');
const c1 = await P.p.textContent('.clock'); await P.p.waitForTimeout(2200);
ok(c1 && c1 == await P.p.textContent('.clock'), 'pause freezes the countdown');
await H.p.click('[data-a=pause]');
await P.p.waitForSelector('text=Paused by the host', {state: 'detached'});
ok(true, 'host resumes the timers');
await P.p.waitForFunction(() => !document.querySelector('[data-a=deal]').disabled, null, {timeout: 12000});
await P.p.click('[data-a=deal]');
await P.p.waitForFunction(() => document.querySelector('.info')?.textContent.includes('Pot 60'), null, {timeout: 3000}).catch(() => {});
for (let k = 0; k < 30 && !(P.last().s.hand && !P.last().s.hand.done && P.last().s.sb == 20); k++) await P.p.waitForTimeout(100);
ok(P.last().s.hand && !P.last().s.hand.done && P.last().s.sb == 20 && P.last().s.hand.cur >= 40, 'dealer deals with their blinds');
if (!turnChecked) { await P.p.waitForSelector('[data-a=fold]', {timeout: 15000}); await checkTurn() }

// Pat stands up; everyone sees them in "Not at the table"
await P.p.click('button:text-is("Stand Up")');
await H.p.waitForFunction(() => document.querySelector('#lobby').textContent.includes('Not at the table'), null, {timeout: 15000});
ok((await H.p.textContent('#lobby')).includes('Pat'), 'players with chips away from the table are listed');
const chips = P.last().s.players.Pat.chips;

// restart: chips, host and names survive
await stop(); await start();
await P.p.reload(); await P.p.waitForSelector('button:text-is("Sit Down")');
ok(P.last().s.players.Pat.chips == chips, 'chips survive a server restart');
await H.p.waitForSelector('text=+ Bot', {timeout: 10000});
ok(true, 'host is still host after restart');
await P.ctx.close();

// a returning player picks their saved name on a new device
const Y = await player('');
await Y.p.waitForSelector('button[data-a=pick]:has-text("Pat")');
await Y.p.click('button[data-a=pick]:has-text("Pat")');
await Y.p.waitForSelector('button:text-is("Sit Down")');
ok(Y.last().you.name == 'Pat' && Y.last().s.players.Pat.chips == chips, 'saved name brings back saved chips');
ok(!Y.last().s.known.includes('Bot 1'), 'bots are not in the name history');

// admin (by password) takes over as host
await Y.p.click('text=Admin');
await Y.p.fill('#ak', 'wrong'); await Y.p.click('text=Unlock'); await Y.p.waitForTimeout(300);
ok((await errText(Y.p)).includes('Wrong'), 'wrong admin password is refused');
// guessing: a burst of wrong passwords from one address locks it out, even for the right one
const replies = await new Promise(done => {
  const w = new WebSocket(`ws://localhost:${PORT}/ws`), out = [];
  w.onmessage = e => { const m = JSON.parse(e.data); if (m.t == 'err' || m.t == 'adminok') out.push(m.t == 'err' ? m.msg : 'ok') };
  w.onopen = async () => { for (const k of ['1', '2', '3', '4', '5', KEY]) { w.send(JSON.stringify({t: 'admin', key: k})); await new Promise(r => setTimeout(r, 50)) } setTimeout(() => { w.close(); done(out) }, 300) };
});
ok(replies.slice(0, 4).every(r => r.includes('Wrong')) && replies[4].includes('15 minutes'), '5 wrong passwords lock that address out');
ok(replies[5].includes('15 minutes'), 'even the right password waits out the lockout');
await stop(); await start(); await Y.p.reload(); await Y.p.waitForSelector('button:text-is("Sit Down")');
await Y.p.click('text=Admin');
await Y.p.fill('#ak', KEY); await Y.p.click('text=Unlock');
await Y.p.click('text=Become host');
await Y.p.waitForSelector('text=+ Bot');
await H.p.waitForFunction(() => !document.querySelector('[data-a=bot]'));
ok(Y.last().s.hostName == 'Pat', 'admin can take over as host');

// admin deletes a saved name; that device goes back to the name screen
await Y.p.click('[data-a=forget][data-v="Hana"]'); await Y.p.click('[data-a=forget][data-v="Hana"]');
await H.p.waitForSelector('#nm');
await Y.p.waitForTimeout(300);
ok(!Y.last().s.known.includes('Hana'), 'admin can delete a saved name');

// reset: everything goes
const R = await player('Rae'); await R.p.waitForSelector('button:text-is("Sit Down")');
await R.p.click('text=Peek').catch(() => {});
await Y.p.click('text=Reset table'); await Y.p.click('text=Tap again to erase everything');
await R.p.waitForSelector('#nm');
ok(!(await R.p.$('button[data-a=pick]')) && !(await R.p.evaluate(() => localStorage.getItem('pn_token'))), 'reset starts every other phone over too');
await Y.p.waitForSelector('#nm');
const s = Y.last().s;
ok(!s.known.length && !Object.keys(s.players).length && !s.hostName, 'reset clears players, chips, names and host');
await Y.p.fill('#nm', 'Pat'); await Y.p.click('text=Join');
await Y.p.waitForSelector('text=+ Bot');
ok(true, 'after a reset the first person in is host again');
await Y.p.click('button:text-is("Sit Down")'); await Y.p.click('[data-a=ok]');
await Y.p.waitForSelector('.st.me');
ok((await Y.p.textContent('.st.me')).includes('👑') && (await Y.p.textContent('#lobby')).includes('👑 Host: Pat'), 'crown marks the host at the table');

// a full table: newcomers wait in line, then get the next open seat
await Y.p.click('[data-a=pause]');
for (let k = 0; k < 11; k++) await Y.p.click('text=+ Bot');
await Y.p.waitForFunction(() => document.querySelectorAll('.st').length == 12);
const Z = await player('Zoe');
await Z.p.click('text=Join the waitlist');
await Z.p.waitForSelector("text=You're #1 in line");
ok((await Y.p.textContent('#lobby')).includes('1. Zoe'), 'everyone sees the waiting list');
ok(await Z.p.$$eval('.st', e => e.length) == 12, 'people in line can watch the table');
await Y.p.click('[data-a=rmbot][data-v="Bot 3"]');
await Z.p.waitForSelector('text=Seat requested');
ok(await Y.p.$eval('#host .p', e => e.classList.contains('turn')), 'an open seat goes to the front of the line, and the host is alerted');
ok(!H.errs.length && !P.errs.length && !Y.errs.length, 'no page errors ' + H.errs.concat(P.errs, Y.errs).join('|'));
await browser.close(); await stop();
console.log(fails ? fails + ' failing' : 'all passed'); process.exit(fails ? 1 : 0);
