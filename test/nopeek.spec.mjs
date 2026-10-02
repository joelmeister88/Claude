// End-to-end: 7 Card No Peek Dr. Pepper in real (phone-sized) browsers. Run: node test/nopeek.spec.mjs
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
ok((await H.p.textContent('[data-a=setgame][data-v=nopeek]')).includes('7 Card No Peek Dr. Pepper'), 'the game is on the list');
await H.p.click('[data-a=setgame][data-v=nopeek]');
await H.p.waitForSelector('[data-a=deal]'); await H.p.click('[data-a=deal]');
await P.p.waitForFunction(() => document.querySelector('#gt').textContent.includes('No Peek'));
const optin = await P.p.$('[data-a=optin1]'); if (optin) await optin.click();
await P.p.waitForSelector('text=Cards flipped', {timeout: 25000});
let s = P.last().s;
ok(s.hand.g == 'nopeek' && s.hand.h[s.seats.indexOf('Pat')].every(c => c === null), 'seven face-down cards, none visible');
const first = s.seats[s.hand.turn], F = first == 'Hana' ? H : P, O = first == 'Hana' ? P : H;
await F.p.waitForSelector('[data-a=flip]');
ok(await O.p.$('[data-a=flip]') == null, 'only the flipper sees Flip');
await F.p.click('[data-a=flip]');
await O.p.waitForSelector('[data-a=call]');
ok(P.last().s.hand.stage == 'bet' && (await O.p.$$eval('.rs', e => e.length)) >= 1, 'first flip is seen by everyone, betting starts');
for (let i = 0; i < 40 && !P.last().s.hand.done; i++) {
  for (const x of [H, P]) { const st = x.last().s.hand; const me = x == H ? 'Hana' : 'Pat';
    if (st.done || x.last().s.seats[st.turn] != me) continue;
    const b = await x.p.$(st.stage == 'flip' ? '[data-a=flipall]' : '[data-a=call]'); if (b) await b.click() }
  await P.p.waitForTimeout(150);
}
ok(P.last().s.hand.done == 1, 'the hand finishes with a winner: ' + P.last().s.hand.msg);
ok(H.errs.length + P.errs.length == 0, 'no page errors: ' + [...H.errs, ...P.errs].join('; '));
await browser.close(); srv.kill(); process.exit(fails ? 1 : 0);
