# Poker Night

Texas Hold'em for friends on their phones, with virtual chips. Friends open a link and type a name; there are no accounts or sign-in.

The server deals and keeps the deck. Each phone only ever receives its own hole cards (plus the live hands at showdown), so nobody can peek at other hands from dev tools.

## Run it locally

```sh
npm install
HOST_KEY=pick-a-secret npm start
```

- Players: `http://localhost:3000/`
- You (host): `http://localhost:3000/#host=pick-a-secret`. Open it once per device. The key is remembered and removed from the address bar, so **Share** never leaks it.

If `HOST_KEY` isn't set, the server makes one up, saves it with the table and prints the host link at startup.

| Env | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST_KEY` | generated | secret part of the host link |
| `DATA_FILE` | `data/table.json` | chip ledger, seats and device logins, saved after every change |

## Deploy

It needs a host that supports WebSockets. One Node process serves the page and the game.

**Render (simplest):** push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up and generates `HOST_KEY`. Find the key under the service's **Environment** tab, then open `https://<your-app>.onrender.com/#host=<HOST_KEY>`.
On the free plan, the service sleeps when idle (the first visit takes a little while to wake it), and its disk is wiped on restarts and deploys, which resets the chip ledger. To keep chips, attach a persistent disk (paid) and set `DATA_FILE` to a path on it.

**Fly.io / anything that runs Docker:** the `Dockerfile` stores the table at `/data/table.json`, so mount a volume at `/data`. For example, with Fly: `fly launch`, `fly volumes create data --size 1`, add a `[mounts]` section with `source = "data"` and `destination = "/data"`, then `fly secrets set HOST_KEY=...`.

## How it works

- `engine.js`: the game. Betting, side pots, the 7-card evaluator, the 10s pause between hands, the 30s choice for busted players, and bots. It has no networking and takes an injectable clock and shuffle so tests are deterministic. `view(name)` is the only thing sent to clients.
- `server.js`: HTTP + WebSocket (`/ws`) server. Clients send `{t:'sit'|'unsit'|'stand'|'buy'|'act'}`; the host sends `{t:'host', op:...}`, which is checked against `HOST_KEY`. After every change, each client gets its own filtered view.
- `public/index.html`: the phone UI.
- Identity: the server hands each device a random token on first join, mapped to a name. A name can't be taken while someone using it is connected. A returning player on a new device can reclaim it while they're offline.
- `artifact/`: the original Claude-artifact version, kept for reference.

## Tests

```sh
npm test               # engine unit tests + end-to-end (real server, headless Chromium)
npm run test:artifact  # the old artifact version
```
