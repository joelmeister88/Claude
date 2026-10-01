# Poker Night

Texas Hold'em for friends on their phones, with virtual chips. Friends open a link and type a name; there are no accounts or sign-in.

The server deals and keeps the deck. Each phone only ever receives its own hole cards (plus the live hands at showdown), so nobody can peek at other hands from dev tools.

## Run it locally

```sh
npm install
HOST_KEY=pick-a-secret npm start
```

- Everyone, including you: `http://localhost:3000/`
- Admin: `http://localhost:3000/#host=pick-a-secret`, or tap **Admin** at the bottom of the page and enter the password. Either way the device remembers it.

If `HOST_KEY` isn't set, the server makes one up, saves it with the table and prints the admin link at startup.

### Who does what

- **Host**: the first person to join the link. Approves seats, gives chips, adds bots, can stand a player up.
- **Dealer**: whoever has the button (the gold **D**). Between hands the dealer picks the blinds and taps **Deal**. If they don't deal within 2 minutes (after the 10s pause), the deal passes to the player on their left. Bots deal on their own, as long as a person is seated.
- **Admin**: anyone with the `HOST_KEY` password. Can **Become host**, delete saved names, and **Reset table**, which erases everyone, all chips, the name history and the host.

### Games (dealer's choice)

- **Texas Hold'em**: the dealer picks the big blind (10 or more, in steps of 10; small blind is half). All bets go up in steps of the big blind; all-in can be any amount.
- **Screw Your Neighbor**: the dealer picks one ante (100 or more, in steps of 100). Everyone pays it once and gets 4 lives. One card each round; keep it or swap with the player on your left, and the dealer goes last and may swap with the deck. Aces are high and can't be taken (show yours, or let a swap reveal it). Everyone tied for lowest loses a life. The same dealer deals the whole game; the deck reshuffles between rounds when it runs low. The last player with lives takes the pot. If the last players all go out together, the pot carries over and players can ante again.

- **Between the Sheets**: the dealer picks one ante (100 or more, in steps of 100). From the dealer's left (dealer last), round and round, each player gets two cards face up (Aces always high) and bets, in 100s up to the whole pot, that the next card lands between them, or passes for free. Between: win the bet from the pot. Outside: pay it in. Same value as either card (hitting the post): pay double, which can go below zero; a player below zero can't join a new game until they're back above it. Next-door cards or a pair: no bet, 10 second pause. The same dealer deals until someone takes the whole pot.

Tap **📖** at the top for the full rules and tips for each game.

New players are asked for their first name and last initial. Returning players tap their name from the saved list, which brings back their chips. Bots aren't saved.

| Env | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST_KEY` | generated | the admin password (5 wrong tries from one address lock it out for 15 minutes) |
| `DATA_FILE` | `data/table.json` | chip ledger, seats and device logins, saved after every change |

## Deploy

It needs a host that supports WebSockets. One Node process serves the page and the game.

**Render (simplest):** push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up and generates `HOST_KEY`. To make it easy to type on a phone, change `HOST_KEY` under the service's **Environment** tab to a password you'll remember.
On the free plan, the service sleeps when idle (the first visit takes a little while to wake it), and its disk is wiped on restarts and deploys, which resets the chip ledger. To keep chips, attach a persistent disk (paid) and set `DATA_FILE` to a path on it.

**Fly.io / anything that runs Docker:** the `Dockerfile` stores the table at `/data/table.json`, so mount a volume at `/data`. For example, with Fly: `fly launch`, `fly volumes create data --size 1`, add a `[mounts]` section with `source = "data"` and `destination = "/data"`, then `fly secrets set HOST_KEY=...`.

## How it works

- `engine.js`: the game. Betting, side pots, the 7-card evaluator, the 10s pause between hands, the 30s choice for busted players, and bots. It has no networking and takes an injectable clock and shuffle so tests are deterministic. `view(name)` is the only thing sent to clients.
- `server.js`: HTTP + WebSocket (`/ws`) server. Clients send `{t:'sit'|'unsit'|'stand'|'buy'|'act'|'deal'}`; the host's device sends `{t:'host', op:...}`, and the admin sends `{t:'admin', ...}` (checked against `HOST_KEY`). After every change, each client gets its own filtered view.
- `public/index.html`: the phone UI.
- Identity: the server hands each device a random token on first join, mapped to a name. A name can't be taken while someone using it is connected. A returning player on a new device can reclaim it while they're offline.
- `artifact/`: the original Claude-artifact version, kept for reference.

## Tests

```sh
npm test               # engine unit tests + end-to-end (real server, headless Chromium)
npm run test:artifact  # the old artifact version
```
