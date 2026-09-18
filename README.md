# Ruung (Trump) — online card game

A 4-player, 2-team trick-taking game ("Ruung" / Trump) you can play online with
friends by sharing a link. Web app: React (client) + a Node WebSocket server
(authoritative — one in-memory game per room). Runs on any normal Node host.

## Run it locally

```bash
npm install
npm run dev
```

- Client (Vite, with hot reload): http://localhost:5173
- Game server (Node + ws): http://localhost:8787 (started automatically; Vite
  proxies the `/ws` connection to it)

Open http://localhost:5173, create a room, and open the same room link in 3 more
browser tabs/windows (or on other devices on your network) to fill the 4 seats.

To run the production build the way a host will:

```bash
npm run build   # builds the client into dist/
npm start       # Node server serves dist/ + WebSockets on PORT (default 8787)
```

## Deploy free and get a shareable URL (Render)

The app is a standard Node web service, so any host with WebSocket support works.
The simplest **free** option is [Render](https://render.com):

1. Push this folder to a **GitHub repo** (see below).
2. Sign in to Render with GitHub (free).
3. **New → Blueprint**, pick the repo. Render reads `render.yaml` and configures
   the build (`npm install && npm run build`) and start (`npm start`) commands.
   (Or **New → Web Service**, pick the repo, and set those two commands manually.)
4. Deploy. You get a URL like `https://ruung.onrender.com`.

Share `https://ruung.onrender.com/#ABCD` (any code after `#`) — everyone who opens
it joins that room.

> Free Render instances sleep after ~15 min idle, so the first visit after a quiet
> spell takes ~50s to wake, then it's fast. Game state lives in memory, so keep it
> to a single instance (the free plan is single-instance by default).

### Pushing to GitHub

```bash
git init
git add -A
git commit -m "Ruung game"
# create an empty repo at github.com/<you>/ruung, then:
git remote add origin https://github.com/<you>/ruung.git
git branch -M main
git push -u origin main
```

## Project layout

```
shared/        Game logic shared by client & server (pure TypeScript)
  types.ts     Cards, phases, messages, the ClientView a player sees
  deck.ts      Deck, shuffle, card labels
  scoring.ts   *** The custom Ruung scoring engine (Rules 4/5/6) ***
  game.ts      Authoritative state machine (draw, auction, 13 tricks, round)
server/
  index.ts     Node + Express + ws server: one in-memory game per room,
               serves the built client, hides other players' hands
src/client/    React UI (mobile-first)
```

## Rules implemented

- **First caller:** round 1 — each player draws one card, highest calls; after
  that the previous round's winner calls.
- **Auction:** first 5 cards are dealt; bid 7 / 10 / 13 on any suit; raise or
  pass; bidding ends when the other three pass; the last (highest) bid sets the
  contract and the trump (Ruung). Remaining cards are then dealt (13 each).
- **Play:** follow suit; highest trump wins, else highest of the led suit.
- **Wasted rounds:** tricks 1, 2, 3 and 12 never score.
- **Seniority ("consecutive 2"):** from trick 4, winning two in a row makes you
  senior; the first breakthrough retroactively credits all tricks so far, then
  the streak keeps crediting.
- **Ace:** wins the trick and keeps your streak alive, but does not score —
  except on the final trick (13), where it scores.

> The scoring interpretation lives entirely in `shared/scoring.ts` and is easy to
> adjust once you've watched a hand play out. See the notes at the top of that file.
