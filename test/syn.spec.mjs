// End-to-end: dealer's choice and Screw Your Neighbor in real (phone-sized) browsers. Run: node test/syn.spec.mjs
import {chromium} from 'playwright';
import {spawn} from 'child_process';
import {mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
const root = new URL('..', import.meta.url).pathname, data = join(mkdtempSync(join(tmpdir(), 'poker-')), 'table.json');
const PORT = 4000 + Math.floor(Math.random() * 1000), URL_ = `http://localhost:${PORT}/`;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ };
const srv = spawn('node', ['server.js'], {cwd: root, env: {...process.env, PORT, HOST_KEY: 'k', DATA_FILE: data}, stdio: ['ignore', 'pipe', 'inherit']});
await new Promise(r => srv.stdout.on('data', d => String(d).includes('Poker Night on') && r()));
process.on('exit', () => srv && srv.kill()); // never leave a server running
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

// rules screen
await P.p.click('[data-a=rules]');
ok((await P.p.textContent('#rules')).includes('Bets and raises go up in steps of the big blind'), "rules: Hold'em, with our table rules");
await P.p.click('[data-a=rulesgame][data-v=syn]');
ok((await P.p.textContent('#rules')).includes('Nobody can take your Ace'), 'rules: Screw Your Neighbor');
await P.p.click('text=Back to the table');
ok(await P.p.isHidden('#rules'), 'rules close');

// Hana deals first: change the game, pick an ante
await H.p.waitForSelector("text=You're the dealer");
await H.p.click('text=Change game'); await H.p.click('[data-a=setgame][data-v=syn]');
await H.p.waitForSelector('#dan');
ok((await P.p.textContent('#gt')).includes('Screw Your Neighbor'), 'everyone sees the new game at the top');
await H.p.fill('#dan', '250'); await H.p.click('#dan + button');
ok(await H.p.inputValue('#dan') == '400', 'ante snaps to 100s; + adds 100');
await H.p.click('[data-a=andn]'); await H.p.click('[data-a=deal]');

await P.p.waitForSelector('[data-a=keep]');
const s = P.last().s;
ok(s.hand.g == 'syn' && s.hand.pot == 600 && s.players.Pat.chips == 700, 'ante of 300 each makes the pot');
ok(await P.p.$$eval('#main .lv.big .coin:not(.x)', e => e.length) == 4, '4 gold-coin lives');
ok(await P.p.textContent('.deck b') == String(s.hand.deckN) && s.hand.deckN == 50, 'cards left in the deck are shown on the deck');
ok(await P.p.$eval('.st.me', e => !!e.querySelector('.c.b')), 'your card stays face down on your seat until you peek');
ok((await P.p.textContent('[data-a=swap]')).includes('Swap with Hana'), 'swap goes to the player on your left');
ok(await P.p.$eval('#main .p', e => e.classList.contains('turn')), 'panel turns red on your turn');
await P.p.click('[data-a=keep]');
await H.p.waitForSelector('text=Swap with the deck');
ok(true, 'the dealer goes last and can swap with the deck');
await H.p.click('[data-a=swap]');
await P.p.waitForFunction(() => /loses? a life/.test(document.querySelector('.info').textContent));
const r = P.last().s.hand;
ok(r.stage == 'reveal' && Object.values(r.cards).every(c => c != null), 'cards are revealed and the lowest loses a life');
await P.p.waitForFunction(() => document.querySelector('.info').textContent.includes('Round 2'), null, {timeout: 9000});
ok(true, 'next round deals itself');

ok(!H.errs.length && !P.errs.length, 'no page errors ' + H.errs.concat(P.errs).join('|'));
await browser.close(); srv.kill();
console.log(fails ? fails + ' failing' : 'all passed'); process.exit(fails ? 1 : 0);
