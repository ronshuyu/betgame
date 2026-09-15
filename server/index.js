'use strict';

const path    = require('path');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
require('dotenv').config();

const fb         = require('./firebaseAdmin');
const { GameManager } = require('./gameManager');

// ─── Express + Socket.io setup ────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20_000,
  pingInterval: 10_000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Initialize Firebase ─────────────────────────────────────────────────────

fb.initFirebase();

// ─── Game Manager ─────────────────────────────────────────────────────────────

const gm = new GameManager(io);

// ─── REST API ─────────────────────────────────────────────────────────────────

/** POST /api/auth/sync — called immediately after Google sign-in */
app.post('/api/auth/sync', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const decoded = await fb.verifyToken(token);
    const player  = await fb.createOrUpdatePlayer(decoded.uid, decoded.name || 'Player', decoded.picture || '');
    res.json({ success: true, player });
  } catch (err) {
    console.error('[/api/auth/sync]', err.message);
    res.status(401).json({ error: 'Authentication failed: ' + err.message });
  }
});

/** GET /api/player/:uid — fetch player profile */
app.get('/api/player/:uid', async (req, res) => {
  try {
    const player = await fb.getPlayer(req.params.uid);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** POST /api/player/topup — add $100 credits (max 3×/day) */
app.post('/api/player/topup', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const decoded = await fb.verifyToken(token);
    const player  = await fb.getPlayer(decoded.uid);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    const today      = new Date().toDateString();
    const sameDay    = player.lastTopupDate === today;
    const todayCount = sameDay ? (player.topupCount || 0) : 0;
    const MAX_PER_DAY = 3;

    if (todayCount >= MAX_PER_DAY) {
      return res.status(429).json({
        error: `Daily top-up limit reached (${MAX_PER_DAY}×/day). Try again tomorrow!`,
        topupsLeft: 0,
      });
    }

    const TOP_UP = 100;
    const newCredits = player.credits + TOP_UP;
    await fb.updateCredits(decoded.uid, newCredits, today, todayCount + 1);

    // Also update the in-memory socket credit so next join works correctly
    const activeSockets = await io.fetchSockets();
    const playerSocket  = activeSockets.find(s => s.uid === decoded.uid);
    if (playerSocket) playerSocket.credits = newCredits;

    // Update credits in gameManager if player is seated at a table
    const tableId = gm.playerTableMap[decoded.uid];
    if (tableId) {
      const table = gm.tables[tableId];
      const seat  = table?.players.find(p => p.uid === decoded.uid);
      if (seat) seat.credits = newCredits;
      io.to(tableId).emit('tableUpdate', gm.getPublicTableState(tableId));
    }

    res.json({
      success: true,
      credits: newCredits,
      topupsLeft: MAX_PER_DAY - todayCount - 1,
    });
  } catch (err) {
    console.error('[/api/player/topup]', err.message);
    res.status(401).json({ error: 'Top-up failed: ' + err.message });
  }
});

/** GET /api/tables — public table listing */
app.get('/api/tables', (_req, res) => {
  res.json(gm.getAllTablesPublic());
});

/** SPA fallback */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Socket.io Auth Middleware ────────────────────────────────────────────────

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    const decoded = await fb.verifyToken(token);
    socket.uid         = decoded.uid;
    socket.displayName = decoded.name  || 'Player';
    socket.photoURL    = decoded.picture || '';

    const player = await fb.getPlayer(decoded.uid);
    socket.credits = player?.credits ?? 500;

    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
});

// ─── Socket.io Events ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[CONNECT]    ${socket.displayName} (${socket.uid}) — sid: ${socket.id}`);

  // Re-attach socket to any table the player was in
  gm.updatePlayerSocket(socket.uid, socket.id);

  // Send current table listing immediately
  socket.emit('allTables', gm.getAllTablesPublic());

  // ── Table actions ──
  socket.on('joinTable', ({ tableId }) => {
    gm.joinTable(socket, socket.uid, socket.displayName, socket.photoURL, socket.credits, tableId);
  });

  socket.on('leaveTable', () => {
    gm.leaveTable(socket, socket.uid);
  });

  socket.on('playerReady', () => {
    gm.playerReady(socket, socket.uid);
  });

  socket.on('playerAction', ({ action, amount = 0 }) => {
    const tableId = gm.playerTableMap[socket.uid];
    if (tableId) gm.handlePlayerAction(tableId, socket.uid, action, amount);
  });

  // ── Disconnect ──
  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] ${socket.displayName} (${socket.uid}) — ${reason}`);
    gm.leaveTable(socket, socket.uid);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, () => {
  console.log(`\n🎮  BETGAME Server  →  http://localhost:${PORT}`);
  console.log(`🔥  Firebase        →  ${fb.isFirebaseEnabled() ? 'Enabled (Firestore)' : 'DEMO MODE (in-memory)'}`);
  console.log(`📋  Tables          →  3 fixed (Low / Mid / High stakes)\n`);
});
