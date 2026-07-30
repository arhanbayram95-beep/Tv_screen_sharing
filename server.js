'use strict';

/*
 * Local-network screen sharing gateway.
 *
 * Express serves the single-page client from ./public, Socket.IO relays WebRTC
 * signalling (offer / answer / ICE) between one "host" (the machine sharing its
 * screen) and up to N "viewers" (the Philips TV browser). Media never touches
 * this process - it only brokers the handshake. Rooms are keyed by a 6-digit
 * PIN so a stranger on the same Wi-Fi cannot silently attach to your screen.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const express = require('express');
const { Server } = require('socket.io');

/* CLI flags beat env vars: `PORT=4000 npm start` is not valid syntax in
 * Windows cmd or PowerShell, so `--port 4000` is the portable spelling. */
function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && value.charAt(0) !== '-' ? value : null;
}

function flagPresent(flag) {
  return process.argv.indexOf(flag) >= 0;
}

// Used when `--stun` is given without a URL. Only reachable with internet
// access, which is precisely when it is wanted.
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

function resolveStun() {
  const explicit = flagValue('--stun');
  if (explicit) return explicit;
  if (flagPresent('--stun')) return DEFAULT_STUN;
  return process.env.STUN_URL || '';
}

const config = {
  port: Number(flagValue('--port') || process.env.PORT || 3000),
  httpsPort: Number(flagValue('--https-port') || process.env.HTTPS_PORT || 3443),
  bindHost: process.env.HOST || '0.0.0.0',
  maxViewersPerRoom: Number(process.env.MAX_VIEWERS || 4),
  // A room with no host and no viewers is dropped immediately; this only caps
  // long-lived idle rooms in case a socket vanishes without a disconnect event.
  roomIdleMs: Number(process.env.ROOM_IDLE_MS || 12 * 60 * 60 * 1000),
  joinFailWindowMs: Number(process.env.JOIN_FAIL_WINDOW_MS || 10 * 60 * 1000),
  joinFailMax: Number(process.env.JOIN_FAIL_MAX || 10),
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  // Empty by default: on a LAN, host candidates are enough and a STUN lookup
  // just adds a timeout when the box has no internet access.
  stunUrl: resolveStun(),
  turnUrl: flagValue('--turn') || process.env.TURN_URL || '',
  turnUsername: flagValue('--turn-user') || process.env.TURN_USERNAME || '',
  turnCredential: flagValue('--turn-pass') || process.env.TURN_CREDENTIAL || '',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ *
 * Room registry
 * ------------------------------------------------------------------ */

/** @type {Map<string, {pin:string, hostId:string, viewers:Set<string>, createdAt:number, lastActivity:number, title:string}>} */
const rooms = new Map();
/** @type {Map<string, {pin:string, role:'host'|'viewer'}>} */
const members = new Map();
/** @type {Map<string, {count:number, first:number, blockedUntil:number}>} */
const joinFailures = new Map();

function generatePin() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!rooms.has(pin)) return pin;
  }
  throw new Error('Could not allocate a free PIN');
}

function closeRoom(pin, reason) {
  const room = rooms.get(pin);
  if (!room) return;
  rooms.delete(pin);
  members.delete(room.hostId);
  room.viewers.forEach((viewerId) => {
    members.delete(viewerId);
    io.to(viewerId).emit('room:closed', { reason });
  });
  log('room closed', pin, reason);
}

function remoteIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

function isRateLimited(ip) {
  const entry = joinFailures.get(ip);
  if (!entry) return false;
  const now = Date.now();
  if (entry.blockedUntil > now) return true;
  if (now - entry.first > config.joinFailWindowMs) {
    joinFailures.delete(ip);
    return false;
  }
  return false;
}

function recordJoinFailure(ip) {
  const now = Date.now();
  const entry = joinFailures.get(ip);
  if (!entry || now - entry.first > config.joinFailWindowMs) {
    joinFailures.set(ip, { count: 1, first: now, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= config.joinFailMax) {
    entry.blockedUntil = now + config.joinFailWindowMs;
    log('rate limited', ip, 'for', Math.round(config.joinFailWindowMs / 1000) + 's');
  }
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');

/*
 * TV browsers cache aggressively, have no devtools, and often no visible way
 * to clear history. `no-cache` still permits a stale copy to be revalidated
 * and served; `no-store` is the only thing these engines reliably honour, and
 * serving a stale page here costs hours of confusion because the symptoms look
 * like the bug you just fixed.
 */
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function sendApp(res) {
  noStore(res);
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), { etag: false, lastModified: false });
}

app.use(
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders(res) {
      noStore(res);
    },
  })
);

// Short, remote-typable aliases. Both render the same SPA; the client reads the
// path to preselect a role so nobody has to arrow through a menu on the couch.
app.get(['/tv', '/viewer', '/watch'], (_req, res) => sendApp(res));
app.get(['/share', '/sender', '/host'], (_req, res) => sendApp(res));
// Self-report page: the only way to see what a TV browser can actually decode.
app.get('/diag', (_req, res) => sendApp(res));

app.get('/api/ice', (_req, res) => {
  const iceServers = [];
  if (config.stunUrl) iceServers.push({ urls: config.stunUrl });
  if (config.turnUrl) {
    iceServers.push({
      urls: config.turnUrl,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }
  res.json({ iceServers, maxViewers: config.maxViewersPerRoom });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

/*
 * Hands the public certificate to a phone that needs to trust it. Safari will
 * not grant camera access on a page whose certificate is untrusted - clicking
 * through the interstitial is not enough - so the cert has to be installed as
 * a profile first. This serves only the certificate; the private key never
 * leaves the server.
 */
app.get(['/cert', '/cert.crt'], (_req, res) => {
  if (!tls || !tls.certPath) {
    res.status(404).type('text/plain').send(
      'Not running with TLS. Start the server with: npm run start:https'
    );
    return;
  }
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="tv-screen-share.crt"');
  res.sendFile(path.resolve(tls.certPath));
});

// `--https` generates a cert on first run; TLS_CERT/TLS_KEY override it.
const wantsHttps = process.argv.indexOf('--https') >= 0;
let server;
let tls = null;

if (config.tlsCert && config.tlsKey) {
  tls = { certPath: config.tlsCert, keyPath: config.tlsKey, created: false };
} else if (wantsHttps) {
  try {
    tls = require('./scripts/make-cert').ensureCert();
    if (tls.created) console.log('  Generated a self-signed certificate in ./certs');
  } catch (err) {
    console.error('\n  Could not enable HTTPS:\n  ' + err.message + '\n');
    process.exit(1);
  }
}

/*
 * Both listeners run at once when TLS is on, sharing one room registry.
 * The TV stays on plain HTTP - several TV browsers cannot dismiss a
 * certificate warning at all - while the phone gets the HTTPS origin its
 * camera requires. It also lets the phone fetch /cert over HTTP first,
 * with no chicken-and-egg trust problem.
 */
server = http.createServer(app);
let secureServer = null;
if (tls) {
  secureServer = https.createServer(
    { cert: fs.readFileSync(tls.certPath), key: fs.readFileSync(tls.keyPath) },
    app
  );
}

const io = new Server({
  // Websocket first: TV browsers cope badly with long-poll reconnect storms.
  // Order here is only an allow-list; the client decides what it tries first.
  transports: ['polling', 'websocket'],
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 256 * 1024,
  cors: { origin: false },
});

io.attach(server);
if (secureServer) io.attach(secureServer);

/* A TV that cannot complete the handshake has no console to look at, so
 * surface the reason on the machine the user is actually sitting at. */
io.engine.on('connection_error', (err) => {
  log('signalling handshake failed:', err.code, '-', err.message,
    err.req && err.req.url ? '(' + err.req.url.split('?')[0] + ')' : '');
});

/* ------------------------------------------------------------------ *
 * Signalling
 * ------------------------------------------------------------------ */

function ack(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

io.on('connection', (socket) => {
  log('connect', socket.id, remoteIp(socket));

  socket.on('host:create', (payload, cb) => {
    if (members.has(socket.id)) {
      const existing = members.get(socket.id);
      if (existing.role === 'host') closeRoom(existing.pin, 'host-restarted');
      else leaveAsViewer(socket.id);
    }

    let pin;
    try {
      pin = generatePin();
    } catch (err) {
      ack(cb, { ok: false, error: 'server-busy' });
      return;
    }

    const title = typeof (payload && payload.title) === 'string' ? payload.title.slice(0, 60) : '';
    rooms.set(pin, {
      pin,
      hostId: socket.id,
      viewers: new Set(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      title,
    });
    members.set(socket.id, { pin, role: 'host' });
    log('room opened', pin, 'by', socket.id);
    ack(cb, { ok: true, pin, maxViewers: config.maxViewersPerRoom });
  });

  socket.on('viewer:join', (payload, cb) => {
    const ip = remoteIp(socket);
    if (isRateLimited(ip)) {
      ack(cb, { ok: false, error: 'too-many-attempts' });
      return;
    }

    const pin = String((payload && payload.pin) || '').trim();
    if (!/^\d{6}$/.test(pin)) {
      recordJoinFailure(ip);
      ack(cb, { ok: false, error: 'bad-pin' });
      return;
    }

    const room = rooms.get(pin);
    if (!room) {
      recordJoinFailure(ip);
      ack(cb, { ok: false, error: 'no-such-room' });
      return;
    }
    if (room.viewers.size >= config.maxViewersPerRoom) {
      ack(cb, { ok: false, error: 'room-full' });
      return;
    }
    if (members.has(socket.id)) leaveAsViewer(socket.id);

    room.viewers.add(socket.id);
    room.lastActivity = Date.now();
    members.set(socket.id, { pin, role: 'viewer' });
    joinFailures.delete(ip);

    const label = typeof (payload && payload.label) === 'string' ? payload.label.slice(0, 40) : '';
    io.to(room.hostId).emit('viewer:joined', { viewerId: socket.id, label, ip });
    log('viewer joined', pin, socket.id);
    ack(cb, { ok: true, hostId: room.hostId, title: room.title });
  });

  socket.on('signal', (msg) => {
    const info = members.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.pin);
    if (!room) return;
    if (!msg || typeof msg.to !== 'string' || typeof msg.data !== 'object' || msg.data === null) return;

    // A viewer may only ever talk to its host, and a host only to its own viewers.
    if (info.role === 'viewer') {
      if (msg.to !== room.hostId) return;
    } else if (!room.viewers.has(msg.to)) {
      return;
    }

    room.lastActivity = Date.now();
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  socket.on('host:kick', (msg) => {
    const info = members.get(socket.id);
    if (!info || info.role !== 'host') return;
    const room = rooms.get(info.pin);
    if (!room || !msg || !room.viewers.has(msg.viewerId)) return;
    room.viewers.delete(msg.viewerId);
    members.delete(msg.viewerId);
    io.to(msg.viewerId).emit('room:closed', { reason: 'kicked' });
  });

  socket.on('host:stop', () => {
    const info = members.get(socket.id);
    if (info && info.role === 'host') closeRoom(info.pin, 'host-stopped');
  });

  socket.on('disconnect', (reason) => {
    const info = members.get(socket.id);
    members.delete(socket.id);
    if (!info) return;
    if (info.role === 'host') {
      closeRoom(info.pin, 'host-disconnected');
    } else {
      const room = rooms.get(info.pin);
      if (room && room.viewers.delete(socket.id)) {
        io.to(room.hostId).emit('viewer:left', { viewerId: socket.id });
      }
    }
    log('disconnect', socket.id, reason);
  });
});

function leaveAsViewer(socketId) {
  const info = members.get(socketId);
  if (!info || info.role !== 'viewer') return;
  const room = rooms.get(info.pin);
  if (room && room.viewers.delete(socketId)) {
    io.to(room.hostId).emit('viewer:left', { viewerId: socketId });
  }
  members.delete(socketId);
}

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, pin) => {
    if (now - room.lastActivity > config.roomIdleMs) closeRoom(pin, 'idle-timeout');
  });
  joinFailures.forEach((entry, ip) => {
    if (now - entry.first > config.joinFailWindowMs && entry.blockedUntil < now) joinFailures.delete(ip);
  });
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function log(...args) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}]`, ...args);
}

function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((entry) => {
      if (entry.family === 'IPv4' && !entry.internal) out.push({ name, address: entry.address });
    });
  });
  return out;
}

function banner() {
  const addresses = lanAddresses();
  const lan = addresses.length ? addresses[0].address : null;
  console.log('');
  console.log('  TV Screen Share is running');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Share this screen  :  http://localhost:${config.port}/share`);
  if (!lan) {
    console.log('  Open on the TV     :  (no LAN interface detected)');
  } else {
    addresses.forEach((entry, index) => {
      const label = index === 0 ? 'Open on the TV     ' : '                   ';
      console.log(`  ${label}:  http://${entry.address}:${config.port}/tv   (${entry.name})`);
    });
  }

  if (secureServer) {
    console.log('  ─────────────────────────────────────────────');
    console.log('  From a phone (camera needs https):');
    console.log(`    1. install cert :  http://${lan || 'localhost'}:${config.port}/cert`);
    console.log(`    2. then open    :  https://${lan || 'localhost'}:${config.httpsPort}/`);
    console.log('  iPhone: after installing, also switch it on under');
    console.log('          Settings > General > About > Certificate Trust Settings.');
  } else {
    console.log('  ─────────────────────────────────────────────');
    console.log('  Screen capture only works on localhost over http.');
    console.log('  To share from a phone or another machine: npm run start:https');
  }
  if (config.stunUrl || config.turnUrl) {
    console.log('  ─────────────────────────────────────────────');
    if (config.stunUrl) console.log('  STUN: ' + config.stunUrl);
    if (config.turnUrl) console.log('  TURN: ' + config.turnUrl);
    console.log('  Viewers outside this network can connect.');
  }
  console.log('');
}

let listening = 0;
const expected = secureServer ? 2 : 1;
function ready() {
  listening += 1;
  if (listening === expected) banner();
}

/* A port clash is the most likely startup failure and Node's default output
 * for it is a bare stack trace, so say what to do instead. */
function onListenError(which, port) {
  return (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(`  Port ${port} is already in use by another program.`);
      console.error('');
      console.error('  Start on a different port instead:');
      console.error(`    npm start -- ${which === 'https' ? '--https --https-port' : '--port'} ${port + 1}`);
      console.error('');
      console.error(`  Whatever port you pick, the TV URL becomes http://<your-ip>:<port>/tv`);
      console.error('');
    } else if (err.code === 'EACCES') {
      console.error(`\n  Not allowed to bind port ${port}. Ports below 1024 need admin rights.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  };
}

server.on('error', onListenError('http', config.port));
server.listen(config.port, config.bindHost, ready);
if (secureServer) {
  secureServer.on('error', onListenError('https', config.httpsPort));
  secureServer.listen(config.httpsPort, config.bindHost, ready);
}

process.on('SIGINT', () => {
  log('shutting down');
  io.close();
  server.close(() => process.exit(0));
  if (secureServer) secureServer.close();
  setTimeout(() => process.exit(0), 2000).unref();
});
