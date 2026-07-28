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

const config = {
  port: Number(process.env.PORT || 3000),
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
  stunUrl: process.env.STUN_URL || '',
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
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

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: 0,
    setHeaders(res) {
      // TV browsers cache aggressively and have no devtools to clear it with.
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// Short, remote-typable aliases. Both render the same SPA; the client reads the
// path to preselect a role so nobody has to arrow through a menu on the couch.
app.get(['/tv', '/viewer', '/watch'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get(['/share', '/sender', '/host'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

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

let server;
if (config.tlsCert && config.tlsKey) {
  server = https.createServer(
    { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) },
    app
  );
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  // Websocket first: TV browsers cope badly with long-poll reconnect storms.
  transports: ['websocket', 'polling'],
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 256 * 1024,
  cors: { origin: false },
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

server.listen(config.port, config.bindHost, () => {
  const scheme = config.tlsCert && config.tlsKey ? 'https' : 'http';
  const addresses = lanAddresses();
  console.log('');
  console.log('  TV Screen Share is running');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Share from this computer :  ${scheme}://localhost:${config.port}/share`);
  if (!addresses.length) {
    console.log('  Open on the TV          :  (no LAN interface detected)');
  } else {
    addresses.forEach((entry, index) => {
      const label = index === 0 ? 'Open on the TV          ' : '                        ';
      console.log(`  ${label}:  ${scheme}://${entry.address}:${config.port}/tv   (${entry.name})`);
    });
  }
  console.log('  ─────────────────────────────────────────────');
  if (scheme === 'http') {
    console.log('  Note: screen capture only works on localhost over http.');
    console.log('        Set TLS_CERT / TLS_KEY to share from another machine.');
  }
  console.log('');
});

process.on('SIGINT', () => {
  log('shutting down');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
