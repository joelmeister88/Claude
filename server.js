'use strict';
// Poker Night server: serves the page and runs the one table over WebSockets.
// Env: PORT (default 3000), ADMIN_PASSWORD (default 8520), HOST_KEY (an extra, older admin key), DATA_FILE.
// Roles: the host is the first device to join (approves seats, gives chips); the admin knows HOST_KEY
// (can take over as host, delete saved names, reset everything); the dealer is whoever holds the button.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const {WebSocketServer} = require('ws');
const {createTable} = require('./engine');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'table.json');
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
// alert sounds: turn (ding), win (game over fanfare), yourdeal (your turn to deal)
const SOUNDS = {};
for (const n of ['turn', 'win', 'yourdeal']) { try { SOUNDS[n] = fs.readFileSync(path.join(__dirname, 'public', 'sounds', n + '.mp3')) } catch (e) { console.error('Missing sound', n) } }

// ---------- persistence: table state + device tokens, written atomically a moment after each change ----------
let saved = {};
try { saved = JSON.parse(fs.readFileSync(DATA, 'utf8')) } catch (e) { if (e.code != 'ENOENT') console.error('Could not read', DATA, e.message) }
const HOST_KEY = process.env.HOST_KEY || saved.hostKey || crypto.randomBytes(9).toString('base64url');
// the admin password; the older HOST_KEY (the #host= link) keeps working too
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8520';
const auth = saved.auth || {}; // device token -> player name
let hostToken = saved.hostToken || ''; // the host's device
let saveT;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA), {recursive: true});
      fs.writeFileSync(DATA + '.tmp', JSON.stringify({state: table.state(), auth, hostToken, hostKey: process.env.HOST_KEY ? undefined : HOST_KEY}));
      fs.renameSync(DATA + '.tmp', DATA);
    } catch (e) { console.error('Could not save table:', e.message) }
  }, 300);
}

const table = createTable(saved.state, {onChange: () => { broadcast(); persist() }});
// one bad message or timer tick must never take the whole table down
const safely = (what, f) => { try { return f() } catch (e) { console.error('Error in ' + what + ':', e) } };
setInterval(() => safely('tick', table.tick), 250);

// ---------- http ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method == 'GET' && url == '/') {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:"});
    return res.end(PAGE);
  }
  const snd = req.method == 'GET' && url.match(/^\/sounds\/(\w+)\.mp3$/);
  if (snd && SOUNDS[snd[1]]) { res.writeHead(200, {'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400', 'content-length': SOUNDS[snd[1]].length}); return res.end(SOUNDS[snd[1]]) }
  if (url == '/healthz') return res.end('ok');
  res.writeHead(404); res.end('Not found');
});

// ---------- websockets ----------
const clients = new Set();
const wss = new WebSocketServer({server, path: '/ws', maxPayload: 4096});
const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)) };
const isHost = c => !!c.token && c.token === hostToken;
const online = () => [...new Set([...clients].map(c => c.name).filter(Boolean))];
function sendState(c, on = online()) {
  send(c, {t: 'state', s: {...table.view(c.name), online: on, hostName: auth[hostToken] || ''}, now: Date.now(),
    you: {name: c.name, host: isHost(c), admin: c.admin}});
}
function broadcast() { const on = online(); for (const c of clients) sendState(c, on) }
// the first person to show up runs the table
function claimHost(c) { if (!auth[hostToken] && c.name) { hostToken = c.token; persist() } }
// admin password tries, per address: 5 wrong in a row locks that address out for 15 minutes
const tries = new Map(), LOCK = 15 * 60000;
function tryKey(c, k) {
  const t = tries.get(c.ip) || {n: 0, until: 0};
  if (Date.now() < t.until) return 'locked';
  if (keyOk(k)) { tries.delete(c.ip); return 'ok' }
  if (++t.n >= 5) { t.n = 0; t.until = Date.now() + LOCK }
  tries.set(c.ip, t); return t.until > Date.now() ? 'locked' : 'wrong';
}
const same = (a, b) => typeof a == 'string' && a.length == b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const keyOk = k => same(k, ADMIN_PASSWORD) || same(k, HOST_KEY);
// names are shown to everyone: letters, digits, spaces and a little punctuation only
const cleanName = n => String(n || '').normalize('NFC').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12);
const isBotName = n => /^bot \d+$/i.test(n);

wss.on('connection', (ws, req) => {
  // behind Render's proxy the last X-Forwarded-For entry is the one the proxy added (earlier ones can be faked)
  const ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  const c = {ws, ip, token: '', name: '', admin: false, alive: true, hits: 0};
  clients.add(c);
  ws.on('pong', () => c.alive = true);
  ws.on('close', () => { clients.delete(c); if (c.name) broadcast() });
  ws.on('message', raw => safely('message', () => {
    if (++c.hits > 30) return; // more than 30 messages a second: drop
    let m; try { m = JSON.parse(raw) } catch (e) { return }
    if (!m || typeof m != 'object') return;
    const err = msg => send(c, {t: 'err', msg});
    if (m.t == 'hello') {
      if (typeof m.token == 'string' && auth[m.token]) { c.token = m.token; c.name = auth[m.token] }
      c.admin = !!m.hostKey && tryKey(c, m.hostKey) == 'ok';
      if (m.hostKey && !c.admin) send(c, {t: 'badkey'});
      claimHost(c); if (c.name) table.remember(c.name);
      return broadcast();
    }
    if (m.t == 'admin') {
      if (m.key !== undefined) {
        const r = tryKey(c, m.key);
        if (r == 'locked') return err('Too many wrong tries. Try again in 15 minutes.');
        if (r != 'ok') return err('Wrong admin password');
        c.admin = true; send(c, {t: 'adminok', key: m.key}); return sendState(c);
      }
      if (!c.admin) return err('Admin only');
      if (m.op == 'takeover') { if (!c.name) return err('Enter your name first'); hostToken = c.token; persist() }
      else if (m.op == 'reset') {
        table.reset(); for (const k in auth) delete auth[k]; hostToken = '';
        for (const o of clients) { o.name = ''; o.token = ''; send(o, {t: 'reset'}) } persist(); return;
      }
      else if (m.op == 'forget') {
        const n = String(m.name || ''), e = table.forget(n); if (e) return err(e);
        for (const k in auth) if (auth[k] == n) delete auth[k];
        for (const o of clients) if (o.name == n) o.name = ''; persist();
      }
      else if (m.op == 'addname' || m.op == 'rename') {
        const n = cleanName(m.name);
        if (!n) return err('Pick a name using letters or numbers');
        if (isBotName(n)) return err('That name is reserved for bots');
        if (m.op == 'addname') { const e = table.addName(n); if (e) return err(e) }
        else {
          const o = String(m.from || ''), e = table.renameName(o, n); if (e) return err(e);
          // devices signed in as the old name carry on as the new one
          for (const k in auth) if (auth[k] == o) auth[k] = n;
          for (const x of clients) if (x.name == o) x.name = n;
        }
        persist();
      }
      return broadcast();
    }
    if (m.t == 'name') {
      const n = cleanName(m.name);
      if (!n) return err('Pick a name using letters or numbers');
      if (isBotName(n)) return err('That name is reserved for bots');
      const p = table.state().players[n];
      if (p && p.bot) return err('That name is taken');
      // a name is locked while another device using it is connected; otherwise a returning player can reclaim it
      for (const o of clients) if (o !== c && o.name == n && o.token != c.token) return err(n + ' is already playing');
      // switching away from a name (picked the wrong one?): that name leaves its seat, if it's free to
      if (c.name && c.name != n) { const e = table.release(c.name); if (e) return err(e) }
      if (!c.token) c.token = crypto.randomBytes(18).toString('base64url');
      auth[c.token] = n; c.name = n; claimHost(c); persist();
      send(c, {t: 'token', token: c.token}); table.remember(n); return broadcast();
    }
    if (m.t == 'host') { if (!isHost(c)) return err('Only the host can do that'); const e = table.host(m); return e && err(e) }
    if (!c.name) return err('Enter your name first');
    const e = table.player(c.name, m); if (e) err(e);
  }));
  sendState(c);
});
// drop dead connections, reset message budgets
setInterval(() => { for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue } c.alive = false; c.ws.ping() } }, 30000);
setInterval(() => { for (const c of clients) c.hits = 0 }, 1000);

server.listen(PORT, () => {
  console.log(`Poker Night on http://localhost:${PORT}`);
  console.log(`Admin: tap Admin and enter the password, or open <your address>/#host=<password>`);
});
