# Jujutsu Card Battle: online server

One Node.js program (no packages to install) that serves the game and runs every online match.
Players only need the link. No accounts, no sign-in, no codes to swap.

How it works
- Create Room gives the host a private 6-digit code. Join Room takes that code. There is no public room list.
- The server runs the match: it owns the game state, rolls every die and coin, and checks every request
  (whose turn, which card, enough CET...). Browsers can only ask; they can never change the game directly.
- Each player sees themselves as the bottom player and the opponent on top, with usernames only.
- Local Play still runs entirely in the browser.

## Important: do not double-click index.html
The page needs the server. Opening `public/index.html` directly shows "game server couldn't be reached".
Start the server first: double-click `start-windows.bat` (Windows) or `start-mac.command` (Mac).
It needs Node.js (free, nodejs.org); the launcher opens that page for you if it is missing.
Then use the link the server prints (http://localhost:3000 on your own computer).

## Get a link (pick one)

### A. Free web host (best: a permanent link, works while the host stays up)
Example with Render (render.com, free plan):
1. Put this folder in a GitHub repository (github.com > New repository > upload the files).
2. On render.com: New > Web Service > connect that repository.
   Runtime: Node. Build command: leave empty. Start command: `node server.js`.
   (A `render.yaml` and `Dockerfile` are included, so Railway, Fly.io and similar also work.)
3. Render gives you a link like https://jujutsu-card-battle.onrender.com. Send it to your friends.
Free plans sleep when idle; the first visit after a while takes about a minute to wake up.

### B. Your own computer (temporary link, works while your PC is on)
1. Install Node.js 18 or newer from nodejs.org.
2. In this folder run: `node server.js`  then open http://localhost:3000
3. To let friends in from anywhere, run a tunnel in a second window, for example:
   `npx cloudflared tunnel --url http://localhost:3000`  (or ngrok / localtunnel)
   It prints a public https link to send to friends.
   Friends on the same Wi-Fi can also use http://YOUR-PC-IP:3000

## Settings (environment variables)
- `PORT`  port to listen on (default 3000)

## Limits
- Rooms live in the server's memory. A restart ends current matches.
- Unstarted rooms expire after 30 minutes. Abandoned matches are cleaned up after 10 minutes.
- Up to 500 rooms at a time.
- If a player closes the page mid-match the other player is told; the match cannot continue without them.
