# Poker Night

Texas Hold'em for friends on their phones, with virtual chips. Friends open a link and type a name; there are no accounts or sign-in.

The server deals and keeps the deck. Each phone only ever receives its own hole cards (plus the live hands at showdown), so nobody can peek at other hands from dev tools.

## Run it locally

```sh
npm install
npm start
```

- Everyone, including you: `http://localhost:3000/`
- Admin: tap **Admin** at the bottom of the page and enter the password (8520 unless `ADMIN_PASSWORD` is set), or open `http://localhost:3000/#host=8520`. Either way the device remembers it.

### Who does what

- **Host**: the first person to join the link. Approves seats, gives chips, adds bots, can stand a player up, pause the timers, and **Cancel game** (or **Undo last game** until the next one starts), which gives everyone back the chips they had before that game.
- **Dealer**: whoever has the button (the gold **D**). Between hands the dealer taps **Deal: <current game>** or **🎲 Change game**, then picks the blind or ante and taps **Deal**. If they don't deal within 2 minutes (after the 10s pause), the deal passes to the player on their left. Bots deal on their own, as long as a person is seated.
- **Admin**: anyone with the admin password. Can **Become host**, delete saved names, and **Reset table**, which erases everyone, all chips, the name history and the host.

### Games (dealer's choice)

- **Texas Hold'em**: the dealer picks the big blind (10 or more, in steps of 10; small blind is half). All bets go up in steps of the big blind; all-in can be any amount.
- **Screw Your Neighbor**: the dealer picks one ante (100 or more, in steps of 100). Everyone pays it once and gets 4 lives. One card each round; keep it or swap with the player on your left, and the dealer goes last and may swap with the deck. Aces are high and can't be taken (show yours, or let a swap reveal it). Everyone tied for lowest loses a life. The same dealer deals the whole game; the deck reshuffles between rounds when it runs low. The last player with lives takes the pot. If the last players all go out together, the pot carries over and players can ante again.

- **Between the Sheets**: the dealer picks one ante (100 or more, in steps of 100). From the dealer's left (dealer last), round and round, each player gets two cards face up (Aces always high) and bets, in 100s up to the whole pot, that the next card lands between them, or passes for free. Between: win the bet from the pot. Outside: pay it in. Same value as either card (hitting the post): pay double, which can go below zero; a player below zero can't join a new game until they're back above it. Next-door cards or a pair: no bet, 10 second pause. The same dealer deals until someone takes the whole pot. When the pot is taken, the three cards stay on the table until the next game starts.

- **5 Card Draw**: the dealer picks the ante (100 or more, in steps of 100) and, if they like, a **wild card value** (every card of that value, marked ★, stands for any card; Five of a kind is the top hand). Five private cards each, a betting round, then everyone in turn swaps up to five cards (tap the cards, then **Swap**, or **Stand pat**), a second betting round, and a showdown. Up to 10 players. 30 seconds to bet or choose cards; running out of time checks/folds or keeps your cards.

When the dealer switches to a different game, everyone else gets 20 seconds to tap **I'm in** or **Sit this one out** (no answer means in). Sitting out keeps your seat and skips the ante/blinds for as long as that game keeps being dealt; **Deal me in** rejoins from the next one.

Tap **📖** at the top for the full rules and tips for each game.

New players are asked for their first name and last initial. Returning players tap their name from the saved list, which brings back their chips. Bots aren't saved.

| Env | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `ADMIN_PASSWORD` | `8520` | the admin password (5 wrong tries from one address lock it out for 15 minutes) |
| `HOST_KEY` | generated | an older admin key that still works too |
| `DATA_FILE` | `data/table.json` | chip ledger, seats and device logins, saved after every change |

## Deploy

It needs a host that supports WebSockets. One Node process serves the page and the game.

**Render (simplest):** push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up and generates `HOST_KEY`. The admin password is 8520; to change it, add `ADMIN_PASSWORD` under the service's **Environment** tab.
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


### Look and alerts

- **🌙/☀️** switches the page between a white and a black background (remembered on each device).
- **🔊/📳/🔇** cycles alerts: sound and vibrate, vibrate only, or off. Alerts fire only for *your turn* (ding + short buzz) and *your turn to deal* (Smash results + double buzz). A fanfare plays when a game ends. Sound files are in `public/sounds/` (`turn.mp3`, `win.mp3`, `yourdeal.mp3`). iPhones don't support vibration from web pages, and a phone needs one tap on the page before it will play sound.
