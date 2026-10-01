'use strict';
// Poker Night server: serves the page and runs the one table over WebSockets.
// Env: PORT (default 3000), HOST_KEY (secret for the host link), DATA_FILE (where the table is saved).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const {WebSocketServer} = require('ws');
const {createTable} = require('./engine');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'table.json');
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// ---------- persistence: table state + device tokens, written atomically a moment after each change ----------
let saved = {};
try { saved = JSON.parse(fs.readFileSync(DATA, 'utf8')) } catch (e) { if (e.code != 'ENOENT') console.error('Could not read', DATA, e.message) }
const HOST_KEY = process.env.HOST_KEY || saved.hostKey || crypto.randomBytes(9).toString('base64url');
const auth = saved.auth || {}; // device token -> player name
let saveT;
function persist() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA), {recursive: true});
      fs.writeFileSync(DATA + '.tmp', JSON.stringify({state: table.state(), auth, hostKey: process.env.HOST_KEY ? undefined : HOST_KEY}));
      fs.renameSync(DATA + '.tmp', DATA);
    } catch (e) { console.error('Could not save table:', e.message) }
  }, 300);
}

const table = createTable(saved.state, {onChange: () => { broadcast(); persist() }});
setInterval(table.tick, 250);

// ---------- http ----------
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method == 'GET' && url == '/') {
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:"});
    return res.end(PAGE);
  }
  if (url == '/healthz') return res.end('ok');
  res.writeHead(404); res.end('Not found');
});

// ---------- websockets ----------
const clients = new Set();
const wss = new WebSocketServer({server, path: '/ws', maxPayload: 4096});
const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)) };
const sendState = c => send(c, {t: 'state', s: table.view(c.name), now: Date.now()});
function broadcast() { for (const c of clients) sendState(c) }
const keyOk = k => typeof k == 'string' && k.length == HOST_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(HOST_KEY));
// names are shown to everyone: letters, digits, spaces and a little punctuation only
const cleanName = n => String(n || '').normalize('NFC').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12);
const isBotName = n => /^bot \d+$/i.test(n);

wss.on('connection', ws => {
  const c = {ws, token: '', name: '', host: false, alive: true, hits: 0};
  clients.add(c);
  ws.on('pong', () => c.alive = true);
  ws.on('close', () => clients.delete(c));
  ws.on('message', raw => {
    if (++c.hits > 30) return; // more than 30 messages a second: drop
    let m; try { m = JSON.parse(raw) } catch (e) { return }
    if (!m || typeof m != 'object') return;
    const err = msg => send(c, {t: 'err', msg});
    if (m.t == 'hello') {
      if (typeof m.token == 'string' && auth[m.token]) { c.token = m.token; c.name = auth[m.token] }
      c.host = keyOk(m.hostKey);
      if (m.hostKey && !c.host) err('That host link is not valid');
      send(c, {t: 'welcome', name: c.name, host: c.host}); return sendState(c);
    }
    if (m.t == 'name') {
      const n = cleanName(m.name);
      if (!n) return err('Pick a name using letters or numbers');
      if (isBotName(n)) return err('That name is reserved for bots');
      const p = table.state().players[n];
      if (p && p.bot) return err('That name is taken');
      // a name is locked while another device using it is connected; otherwise a returning player can reclaim it
      for (const o of clients) if (o !== c && o.name == n && o.token != c.token) return err(n + ' is already playing');
      if (!c.token) c.token = crypto.randomBytes(18).toString('base64url');
      auth[c.token] = n; c.name = n; persist();
      send(c, {t: 'welcome', name: n, host: c.host, token: c.token}); return sendState(c);
    }
    if (m.t == 'host') { if (!c.host) return err('Only the host can do that'); const e = table.host(m); return e && err(e) }
    if (!c.name) return err('Enter your name first');
    const e = table.player(c.name, m); if (e) err(e);
  });
  sendState(c);
});
// drop dead connections, reset message budgets
setInterval(() => { for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue } c.alive = false; c.ws.ping() } }, 30000);
setInterval(() => { for (const c of clients) c.hits = 0 }, 1000);

server.listen(PORT, () => {
  console.log(`Poker Night on http://localhost:${PORT}`);
  console.log(`Host link: <your address>/#host=${HOST_KEY}` + (process.env.HOST_KEY ? '' : '  (set HOST_KEY to choose your own)'));
});
