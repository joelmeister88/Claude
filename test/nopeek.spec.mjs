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
await F.p.waitForSelector('.cb.go');
ok(await O.p.$('.cb.go') == null, 'only the flipper can tap cards');
{ // tap the third card: the third card is the one that turns over
  const b = await F.p.$$('.cb.go'); await b[2].click();
  await F.p.waitForFunction(() => document.querySelectorAll('.cb.go').length < 7 || !document.querySelector('.cb.go'));
  const mine = F.last().s.hand.h[F.last().s.seats.indexOf(first)];
  ok(mine[2] !== null && mine.filter(x => x !== null).length == 1, 'the card you tap is the one that flips');
}
ok((await P.p.textContent('.info')).includes('Card to beat') && await P.p.$('.mid .c:not(.b)'), "the dealer's card is on the table, labelled underneath");
ok(await P.p.evaluate(() => { const a = document.querySelector('.mid').getBoundingClientRect(), b = document.querySelector('.info').getBoundingClientRect(); return a.bottom <= b.top + 1 }), "the card and the text under it don't overlap");
if (await F.p.$('.cb.go')) await F.p.click('.cb.go >> nth=0'); // (unless that one tap already took the lead)
await F.p.waitForFunction(() => document.querySelectorAll('.p .c.nk:not(.b)').length >= 1);
ok((await O.p.$$eval('.rs', e => e.length)) >= 1, 'a flipped card is seen by everyone');
for (let i = 0; i < 40 && !P.last().s.hand.done; i++) {
  for (const x of [H, P]) { const st = x.last().s.hand; const me = x == H ? 'Hana' : 'Pat';
    if (st.done || x.last().s.seats[st.turn] != me) continue;
    // look the button up at click time (the page may have redrawn since the last update)
    const sel = st.stage == 'flip' ? '.cb.go' : '[data-a=call]';
    if (await x.p.$(sel)) await x.p.locator(sel).first().click({timeout: 2000}).catch(() => {}) }
  await P.p.waitForTimeout(150);
}
ok(P.last().s.hand.done == 1, 'the hand finishes with a winner: ' + P.last().s.hand.msg);
ok(H.errs.length + P.errs.length == 0, 'no page errors: ' + [...H.errs, ...P.errs].join('; '));
await browser.close(); srv.kill(); process.exit(fails ? 1 : 0);
