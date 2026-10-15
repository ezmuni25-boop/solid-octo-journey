'use strict';
/* Jujutsu Card Battle: game server.
   Zero dependencies (Node 18+). It does three things:
     1. serves the game page and card images from ./public
     2. hands out private 6-digit rooms (no public room list, rooms are reachable only by code)
     3. runs every online match. The game engine lives ONLY here for online play. Browsers can only send
        requests ("pick this card", "use that move"); the server checks each one against the rules,
        rolls all dice and coins, and streams the resulting game state back.
   Transport: Server-Sent Events (server -> browser) and plain POST (browser -> server).
   Run:  node server.js        (PORT environment variable sets the port, default 3000) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const LOBBY_TTL = 30 * 60 * 1000;        // an unstarted room disappears after 30 minutes
const MATCH_IDLE_TTL = 10 * 60 * 1000;   // a match with nobody connected disappears after 10 minutes
const HOST_GRACE = 25 * 1000;            // a host who vanishes from the lobby closes the room after this long
const MAX_ROOMS = 500;
const MAX_BODY = 8 * 1024;

/* ---------- the game engine, taken from the page itself so there is exactly one copy of the rules ---------- */
function loadEngine() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const grab = (a, b) => {
    const i = html.indexOf(a), j = html.indexOf(b, i);
    if (i < 0 || j < 0) throw new Error('engine markers missing in public/index.html: ' + a);
    return html.slice(i + a.length, j);
  };
  const src = grab('//@@CORE-A-BEGIN', '//@@CORE-A-END') + '\n' + grab('//@@CORE-B-BEGIN', '//@@CORE-B-END');
  return new Function(src + '\n;return { createEngine: createEngine };')();
}
const Engine = loadEngine();

/* ---------- small helpers ---------- */
const rooms = new Map();    // code -> room
const tokens = new Map();   // token -> { room, seat }
const hits = new Map();     // ip -> [timestamps]

function cleanName(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(100000 + crypto.randomInt(900000));
    if (!rooms.has(c)) return c;
  }
  return null;
}
function tooMany(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > 30;
}
setInterval(() => { const now = Date.now(); hits.forEach((l, k) => { if (!l.some(t => now - t < 60000)) hits.delete(k); }); }, 60000).unref();

/* ---------- rooms ---------- */
function roomView(r) {
  const p = (s) => s ? { name: s.name, connected: !!s.res } : null;
  return { code: r.code, started: r.started, closed: r.closed || '', host: p(r.seats[1]), guest: p(r.seats[2]), left: r.left || 0 };
}
function send(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
}
function broadcastView(r) {
  const v = roomView(r);
  [1, 2].forEach(n => { const s = r.seats[n]; if (s && s.res) send(s.res, 'view', v); });
}
function closeRoom(r, why) {
  if (r.closed && !rooms.has(r.code)) return;
  r.closed = why; r.lastActive = Date.now();
  if (r.engine) { try { r.engine.destroy(); } catch (e) {} r.engine = null; }
  broadcastView(r);
  [1, 2].forEach(n => { const s = r.seats[n]; if (s && s.res) { try { s.res.end(); } catch (e) {} s.res = null; } });
  rooms.delete(r.code);
  [1, 2].forEach(n => { const s = r.seats[n]; if (s) tokens.delete(s.token); });
}
function anyConnected(r) { return [1, 2].some(n => r.seats[n] && r.seats[n].res); }

setInterval(() => {
  const now = Date.now();
  rooms.forEach(r => {
    if (!r.started && now - r.created > LOBBY_TTL) return closeRoom(r, 'expired');
    if (!anyConnected(r) && now - r.lastActive > (r.started ? MATCH_IDLE_TTL : HOST_GRACE)) return closeRoom(r, 'all-left');
    const h = r.seats[1];
    if (!r.started && h && !h.res && now - h.lastSeen > HOST_GRACE) return closeRoom(r, 'host-disconnected');
    [1, 2].forEach(n => { const s = r.seats[n]; if (s && s.res) { try { s.res.write(': ping\n\n'); } catch (e) {} } });
  });
}, 10000).unref();

/* ---------- HTTP API ---------- */
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function who(token) {
  const t = typeof token === 'string' ? tokens.get(token) : null;
  return t && rooms.get(t.room.code) === t.room ? t : null;
}

async function api(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const t = who(url.searchParams.get('token'));
    if (!t) { res.writeHead(404); return res.end(); }
    const r = t.room, seat = r.seats[t.seat];
    if (seat.res) { try { seat.res.end(); } catch (e) {} }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    seat.res = res; seat.lastSeen = Date.now(); r.lastActive = Date.now();
    req.on('close', () => {
      if (seat.res === res) { seat.res = null; seat.lastSeen = Date.now(); r.lastActive = Date.now(); if (rooms.get(r.code) === r) broadcastView(r); }
    });
    send(res, 'view', roomView(r));
    if (r.engine && r.lastState) send(res, 'state', r.lastState);
    broadcastView(r);
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Not allowed.' });
  if ((url.pathname === '/api/create' || url.pathname === '/api/join') && tooMany(ip)) return json(res, 429, { ok: false, message: 'Too many attempts. Wait a minute and try again.' });
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, message: 'Bad request.' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { ok: false, message: 'Bad request.' });

  if (url.pathname === '/api/create') {
    const name = cleanName(body.name);
    if (!name) return json(res, 200, { ok: false, message: 'Enter a username first.' });
    if (rooms.size >= MAX_ROOMS) return json(res, 200, { ok: false, message: 'The server is full right now. Try again soon.' });
    const code = newCode();
    if (!code) return json(res, 200, { ok: false, message: 'Could not make a room code. Try again.' });
    const token = newToken(), now = Date.now();
    const r = { code, created: now, lastActive: now, started: false, closed: '', left: 0, engine: null, lastState: null, seats: { 1: { name, token, res: null, lastSeen: now }, 2: null } };
    rooms.set(code, r); tokens.set(token, { room: r, seat: 1 });
    return json(res, 200, { ok: true, code, token, role: 'host' });
  }
  if (url.pathname === '/api/join') {
    const name = cleanName(body.name), code = String(body.code || '');
    if (!name) return json(res, 200, { ok: false, message: 'Enter a username first.' });
    if (!/^\d{6}$/.test(code)) return json(res, 200, { ok: false, message: 'Room codes are exactly 6 digits.' });
    const r = rooms.get(code);
    if (!r) return json(res, 200, { ok: false, message: 'No room with that code.' });
    if (r.started) return json(res, 200, { ok: false, message: 'That match has already started.' });
    if (r.seats[2]) return json(res, 200, { ok: false, message: 'That room is full.' });
    let nm = name;
    if (nm.toLowerCase() === r.seats[1].name.toLowerCase()) nm = nm.slice(0, 12) + ' (2)';
    const token = newToken(), now = Date.now();
    r.seats[2] = { name: nm, token, res: null, lastSeen: now };
    tokens.set(token, { room: r, seat: 2 }); r.lastActive = now;
    broadcastView(r);
    return json(res, 200, { ok: true, code, token, role: 'guest' });
  }
  const t = who(body.token);
  if (!t) return json(res, 200, { ok: false, message: 'This room no longer exists.', gone: true });
  const r = t.room, seat = t.seat;
  r.lastActive = Date.now();
  const sd = r.seats[seat], nowMs = Date.now();
  sd.rate = (sd.rate || []).filter(x => nowMs - x < 1000); sd.rate.push(nowMs);
  if (sd.rate.length > 20) return json(res, 429, { ok: false, msg: 'Slow down a little.' });

  if (url.pathname === '/api/start') {
    if (seat !== 1) return json(res, 200, { ok: false, message: 'Only the host can start the match.' });
    if (r.started) return json(res, 200, { ok: true });
    if (!r.seats[2] || !r.seats[2].res) return json(res, 200, { ok: false, message: 'Your opponent is not connected.' });
    r.started = true;
    const names = [r.seats[1].name, r.seats[2].name];
    r.engine = Engine.createEngine({ online: true, names, publish: st => {
      r.lastState = st;
      [1, 2].forEach(n => { const s = r.seats[n]; if (s && s.res) send(s.res, 'state', st); });
    } });
    broadcastView(r);
    r.engine.start();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/act') {
    if (!r.engine) return json(res, 200, { ok: false, msg: 'The match has not started.' });
    if (!body.action || typeof body.action !== 'object' || Array.isArray(body.action)) return json(res, 200, { ok: false, msg: 'Unknown request.' });
    let out;
    try { out = r.engine.request(seat, body.action); } catch (e) { out = { ok: false, msg: 'That request was refused.' }; }
    return json(res, 200, out || { ok: false, msg: 'That request was refused.' });
  }
  if (url.pathname === '/api/leave') {
    if (!r.started && seat === 1) closeRoom(r, 'host-left');
    else if (!r.started) { tokens.delete(r.seats[2].token); r.seats[2] = null; broadcastView(r); }
    else { r.left = seat; if (r.seats[seat].res) { try { r.seats[seat].res.end(); } catch (e) {} r.seats[seat].res = null; } broadcastView(r); if (!anyConnected(r)) closeRoom(r, 'all-left'); }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, message: 'Unknown request.' });
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch(() => { try { json(res, 500, { ok: false, message: 'Server error.' }); } catch (e) {} });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});
server.keepAliveTimeout = 65000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nJujutsu Card Battle is running.\n');
  console.log('  On this computer:     http://localhost:' + PORT);
  const os = require('os');
  Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log('  Same Wi-Fi / network: http://' + i.address + ':' + PORT));
  console.log('\nFor friends elsewhere, put this behind a tunnel or host it (see README.md). Close this window to stop the server.\n');
});
