const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_GAMES = 5000;
const IDLE_MS = 2 * 60 * 60 * 1000;
const CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

const games = new Map();

function newCode() {
  for (let t = 0; t < 50; t++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CH[Math.floor(Math.random() * CH.length)];
    if (!games.has(c)) return c;
  }
  return null;
}

const symOf = (g, pid) => (g.x === pid ? 'X' : g.o === pid ? 'O' : '');

function view(g, code, pid) {
  return {
    code, board: g.board, turn: g.turn, winner: g.winner, line: g.line,
    round: g.round, sx: g.sx, so: g.so, hasO: !!g.o, you: symOf(g, pid),
  };
}

function broadcast(code) {
  const g = games.get(code);
  if (!g) return;
  g.last = Date.now();
  for (const c of g.clients) {
    c.res.write('data: ' + JSON.stringify(view(g, code, c.pid)) + '\n\n');
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (ch) => { data += ch; if (data.length > 1024) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const validCode = (c) => typeof c === 'string' && /^[A-Z0-9]{4}$/.test(c);
const validPid = (p) => typeof p === 'string' && /^[a-z0-9]{6,40}$/.test(p);

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const code = (url.searchParams.get('code') || '').toUpperCase();
    const pid = url.searchParams.get('pid') || '';
    const g = games.get(code);
    if (!validCode(code) || !validPid(pid) || !g) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const client = { res, pid };
    g.clients.add(client);
    res.write('data: ' + JSON.stringify(view(g, code, pid)) + '\n\n');
    const hb = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); g.clients.delete(client); });
    return;
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  let b;
  try { b = await readJson(req); } catch (e) { return send(res, 400, { error: 'bad_request' }); }
  if (!validPid(b.pid)) return send(res, 400, { error: 'bad_pid' });

  if (url.pathname === '/api/create') {
    if (games.size >= MAX_GAMES) return send(res, 503, { error: 'busy' });
    const code = newCode();
    if (!code) return send(res, 503, { error: 'busy' });
    games.set(code, {
      x: b.pid, o: '', board: '.........', turn: 'X', winner: '', line: '',
      round: 1, sx: 0, so: 0, clients: new Set(), last: Date.now(),
    });
    return send(res, 200, { code });
  }

  const code = String(b.code || '').toUpperCase();
  if (!validCode(code)) return send(res, 400, { error: 'bad_code' });
  const g = games.get(code);
  if (!g) return send(res, 404, { error: 'not_found' });

  if (url.pathname === '/api/join') {
    if (g.x !== b.pid && g.o !== b.pid) {
      if (g.o) return send(res, 409, { error: 'full' });
      g.o = b.pid;
      broadcast(code);
    }
    return send(res, 200, { code });
  }

  const sym = symOf(g, b.pid);
  if (!sym) return send(res, 403, { error: 'not_player' });

  if (url.pathname === '/api/move') {
    const i = Number(b.i);
    if (!Number.isInteger(i) || i < 0 || i > 8) return send(res, 400, { error: 'bad_move' });
    if (!g.o || g.winner || g.turn !== sym || g.board[i] !== '.') return send(res, 409, { error: 'illegal' });
    g.board = g.board.slice(0, i) + sym + g.board.slice(i + 1);
    for (const l of LINES) {
      if (g.board[l[0]] !== '.' && g.board[l[0]] === g.board[l[1]] && g.board[l[0]] === g.board[l[2]]) {
        g.winner = g.board[l[0]]; g.line = l.join(''); break;
      }
    }
    if (!g.winner && !g.board.includes('.')) g.winner = 'D';
    if (g.winner === 'X') g.sx++;
    if (g.winner === 'O') g.so++;
    if (!g.winner) g.turn = sym === 'X' ? 'O' : 'X';
    broadcast(code);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/again') {
    if (!g.winner) return send(res, 409, { error: 'not_over' });
    g.board = '.........'; g.winner = ''; g.line = ''; g.round++;
    g.turn = g.round % 2 === 1 ? 'X' : 'O';
    broadcast(code);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not_found' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, games: games.size });
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(() => send(res, 500, { error: 'server' }));
  serveStatic(req, res, url);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) if (g.clients.size === 0 && now - g.last > IDLE_MS) games.delete(code);
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log('Tres en raya escuchando en http://localhost:' + PORT));
