// End-to-end: 5 Card Draw (with a wild card), theme and sound buttons in real (phone-sized) browsers. Run: node test/draw.spec.mjs
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

// theme + sound buttons
const bg = async p => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
await H.p.click('#th'); const b1 = await bg(H.p); await H.p.click('#th'); const b2 = await bg(H.p);
ok(new Set([b1, b2]).size == 2 && ['rgb(255, 255, 255)', 'rgb(0, 0, 0)'].every(c => [b1, b2].includes(c)), 'theme button flips between white and black');
await H.p.click('#snd'); ok((await H.p.textContent('#snd')) == '📳', 'sound button: vibrate only'); await H.p.click('#snd'); await H.p.click('#snd');
const mp3 = await H.p.evaluate(async () => (await fetch('/sounds/turn.mp3')).headers.get('content-type'));
ok(mp3 == 'audio/mpeg', 'alert sounds are served');

await H.p.click('text=Change game');
ok((await H.p.textContent('[data-a=setgame][data-v=draw]')).includes('5 Card Draw'), '5 Card Draw is on the game list');
await H.p.click('[data-a=setgame][data-v=draw]');
await H.p.waitForSelector('#dwl'); ok(true, 'dealer gets a wild card picker');
await H.p.selectOption('#dwl', '5'); // 7s are wild
await H.p.click('[data-a=deal]');
await P.p.waitForFunction(() => document.querySelector('#gt').textContent.includes('5 Card Draw'));
const optin = await P.p.$('[data-a=optin1]'); if (optin) await optin.click();
await P.p.waitForFunction(() => document.querySelectorAll('.p .c.md').length == 5, null, {timeout: 25000});
let s = P.last().s;
ok(s.hand.g == 'draw' && s.hand.wild == 5 && s.hand.h[s.seats.indexOf('Pat')].length == 5, 'five cards each, 7s wild');
ok((await P.p.textContent('.mid')).includes('Wild: 7s'), 'the table shows the wild value');
// betting round one: whoever's turn calls
async function callIfTurn(x) { const b = await x.p.$('[data-a=call]'); if (b) { await b.click(); return true } return false }
for (let i = 0; i < 10 && !(P.last().s.hand.stage == 1); i++) { await callIfTurn(H) || await callIfTurn(P); await P.p.waitForTimeout(150) }
ok(P.last().s.hand.stage == 1, 'after betting comes the draw');
const dr = [H, P].find(x => x.last().s.seats[x.last().s.hand.turn] == (x == H ? 'Hana' : 'Pat'));
await dr.p.click('.cb >> nth=0'); await dr.p.click('.cb >> nth=1');
ok((await dr.p.textContent('[data-a=drawgo]')).includes('Swap 2'), 'tapping cards selects them to swap');
await dr.p.click('[data-a=drawgo]');
const other = dr == H ? P : H; await other.p.waitForSelector('[data-a=drawgo]');
await other.p.click('[data-a=drawgo]'); // stand pat
await P.p.waitForFunction(() => document.querySelector('[data-a=call]'), null, {timeout: 5000});
ok(P.last().s.hand.stage == 2, 'second betting round');
for (let i = 0; i < 10 && !P.last().s.hand.done; i++) { await callIfTurn(H) || await callIfTurn(P); await P.p.waitForTimeout(150) }
ok(P.last().s.hand.done == 1, 'showdown');
await P.p.waitForSelector('text=Hands');
ok(await P.p.$$eval('.rs', e => e.length) >= 5, 'all hands shown at the end');
ok(H.errs.length + P.errs.length == 0, 'no page errors: ' + [...H.errs, ...P.errs].join('; '));
await browser.close(); srv.kill(); process.exit(fails ? 1 : 0);
