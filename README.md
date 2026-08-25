# 3 of Spades

A browser-based, real-time-ish multiplayer trick-taking card game for 4-8 players:
bidding, a chosen trump suit, secret partners revealed mid-round, and a 250-point
scoring hand (or 500-point with the two-deck variant).

This is a static frontend (`index.html` / `styles.css` / `engine.js` / `app.js`)
plus a single serverless API route (`api/room.js`) that stores each room's game
state in Redis (via [Upstash](https://upstash.com), installed through the
Vercel Marketplace) so multiple devices can join the same room and stay in
sync.

> **Note:** Vercel's old built-in "Vercel KV" product (and the `@vercel/kv`
> package) has been discontinued. This project uses `@upstash/redis` instead,
> which is the current recommended replacement — see the deploy steps below.

## How it's organized

```
index.html     - page shell, loads engine.js then app.js
styles.css     - all styling
engine.js      - pure game logic (dealing, bidding, tricks, scoring) - no DOM code
app.js         - rendering, event handling, polling, and the fetch() calls to /api/room
api/room.js    - serverless function: GET/POST room state to/from Redis (Upstash)
```

`engine.js` has no dependency on the DOM or on how state is stored, so it's easy
to unit test or reuse.

## Run locally

You'll need the [Vercel CLI](https://vercel.com/docs/cli) since the game depends
on the `/api/room` serverless function (a plain static server won't serve that).

```bash
npm install -g vercel
npm install
vercel dev
```

`vercel dev` will prompt you to link a Vercel project the first time you run it -
that's fine even before you've deployed anything. Local dev still needs the
Redis env vars from the step below (run `vercel env pull .env.development.local`
after completing it once, so `vercel dev` can read them).

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, "Add New Project" and import that repo. No build settings needed
   (it's detected as a static site with an `api/` function).
3. **This step is required** — the app has no working storage until you do this:
   open your project in Vercel, go to the **Storage** tab (or the
   [Marketplace](https://vercel.com/marketplace/upstash)), and install/link
   **"Upstash for Redis"**. Create a new database (or link an existing one) and
   connect it to this project. That automatically injects the environment
   variables `api/room.js` needs (`Redis.fromEnv()` picks up whichever of
   `UPSTASH_REDIS_REST_URL`/`TOKEN` or `KV_REST_API_URL`/`TOKEN` are present) —
   you don't need to copy any keys by hand.
4. Redeploy after connecting the database so the new env vars take effect.

Once that's done, anyone with the URL can create a room, share the 4-letter
room code, and play from separate devices/browsers.

### If "create table" still fails after deploying

1. **Visit `/api/health` on your deployed URL directly in the browser**
   (e.g. `https://your-app.vercel.app/api/health`). It returns JSON telling
   you exactly what's wrong:
   - `"stage": "env"` → no Redis env vars are present on this deployment at
     all. This almost always means either the Upstash integration was never
     connected to *this* project, or you connected it but haven't redeployed
     since (env vars only take effect on deployments made *after* they're
     added — this is the single most common cause).
   - `"stage": "redis"` with `"ok": false` → env vars exist but the actual
     Redis call failed (check the `error` field — often a stale/rotated
     token, or the linked database was deleted).
   - `"ok": true` → storage itself is working; if table creation still fails
     at this point, open the browser console on the create-table page — as of
     this version, errors are logged there and shown in the toast message
     instead of a generic "Could not create table".
2. Also check Vercel → your project → **Deployments** → latest deployment →
   **Functions** → `api/room` for server-side logs.
3. Make sure the Redis integration is linked to the same **Environment**
   (Production vs. Preview) as the URL you're testing — a database connected
   only to Preview won't have vars on your Production deployment, or vice
   versa.
4. After any of the above fixes, **redeploy** — Vercel doesn't retroactively
   apply new env vars to old deployments.

## Notes / limitations

- Hands are hidden by the UI, not by encryption — anyone who opened devtools
  and inspected the API response could see all hands. Fine for a friendly game,
  not meant to be cheat-proof.
- No accounts/auth: rejoining a room after a page reload works by re-entering
  the same name you joined with.
- Rooms auto-expire from KV after 6 hours of inactivity (see `ROOM_TTL_SECONDS`
  in `api/room.js`) so old test rooms don't accumulate — change or remove that
  if you want rooms to persist longer.
- The client polls `/api/room` every 2.5s per active player; fine for casual
  play, but if you expect heavy concurrent traffic you'll want a real-time
  transport (WebSockets/Pusher/Ably) instead of polling.

## Game rules implemented

- 4-8 players, cards dealt evenly; low cards (2s, then non-spade 3s) are
  trimmed from the deck only as needed to divide evenly - point cards are
  never touched.
- 250 points per round (500 with the two-deck option): A/K/Q/J/10 = 10 pts
  each, 5 = 5 pts, 3 of Spades = 30 pts.
- Bidding opens at 130 (255 with two decks) and rises in multiples of 5.
- The winning bidder picks trump and calls partners in secret; partners
  are revealed only when they play the called card.
- Must follow suit if possible; otherwise any card (including trump) may
  be played. Highest trump wins the trick, or highest card of the led suit
  if no trump was played.
- **Two-deck variant**: partners are called by rank + suit + whether it's
  the 1st or 2nd copy played (since each card exists twice). If the same
  card is thrown twice in one trick, the later copy wins the tie.
