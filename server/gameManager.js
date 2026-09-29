'use strict';

const { dealHands, evaluateHand, compareHands } = require('./gameLogic');
const fb = require('./firebaseAdmin');

// ─── Table Definitions ────────────────────────────────────────────────────────
const TABLE_CONFIGS = [
  { id: 'table-1', name: 'Low Stakes',  baseBet:  5, maxPlayers: 12, minPlayers: 2, color: '#2ecc71' },
  { id: 'table-2', name: 'Mid Stakes',  baseBet: 20, maxPlayers: 12, minPlayers: 2, color: '#f39c12' },
  { id: 'table-3', name: 'High Stakes', baseBet: 50, maxPlayers: 12, minPlayers: 2, color: '#e74c3c' },
];

const PHASE = {
  WAITING:  'WAITING',
  DEALING:  'DEALING',
  BETTING:  'BETTING',
  SHOWDOWN: 'SHOWDOWN',
  PAYOUT:   'PAYOUT',
};

const ACTION_TIMEOUT_MS  = 30_000; // 30 s per turn
const PAYOUT_DISPLAY_MS  =  5_000; // show results for 5 s
const PRE_DEAL_DELAY_MS  =  2_000; // animation delay before dealing

// ─── GameManager ──────────────────────────────────────────────────────────────

class GameManager {
  constructor(io) {
    this.io  = io;
    this.tables          = {};   // tableId → TableState
    this.playerTableMap  = {};   // uid → tableId
    this.actionTimers    = {};   // tableId → NodeJS.Timeout

    for (const cfg of TABLE_CONFIGS) {
      this.tables[cfg.id] = this._makeTable(cfg);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _makeTable(cfg) {
    return {
      ...cfg,
      players:         [],  // { uid, displayName, photoURL, credits, seat, status, isReady, socketId }
      phase:           PHASE.WAITING,
      pot:             0,
      currentBet:      0,
      currentPlayerIdx: 0,
      dealerIdx:       0,
      hands:           {},  // uid → Card[]
      evaluations:     {},  // uid → EvalResult
      betsMade:        {},  // uid → number (total put in this round)
      hasActed:        {},  // uid → boolean
      raisedThisRound: false,
      startCountdown:  null,
    };
  }

  _activePlayers(table) {
    return table.players.filter(p => p.status === 'active');
  }

  _clearActionTimer(tableId) {
    if (this.actionTimers[tableId]) {
      clearTimeout(this.actionTimers[tableId]);
      delete this.actionTimers[tableId];
    }
  }

  _getSocket(socketId) {
    return this.io.sockets.sockets.get(socketId);
  }

  /** Safe async DB updates — game never pauses for these. */
  _syncCredits(uid, credits) {
    fb.updateCredits(uid, credits).catch(e => console.error('[DB] updateCredits:', e.message));
  }
  _syncWin(uid)  { fb.recordWin(uid).catch(e  => console.error('[DB] recordWin:',  e.message)); }
  _syncLoss(uid) { fb.recordLoss(uid).catch(e => console.error('[DB] recordLoss:', e.message)); }

  // ── Public table views ───────────────────────────────────────────────────────

  getPublicTableState(tableId) {
    const t = this.tables[tableId];
    if (!t) return null;
    return {
      id:          t.id,
      name:        t.name,
      baseBet:     t.baseBet,
      maxPlayers:  t.maxPlayers,
      minPlayers:  t.minPlayers,
      color:       t.color,
      phase:       t.phase,
      pot:         t.pot,
      currentBet:  t.currentBet,
      currentPlayerIdx: t.currentPlayerIdx,
      raisedThisRound: t.raisedThisRound,
      players:     t.players.map(p => ({
        uid:        p.uid,
        displayName: p.displayName,
        photoURL:   p.photoURL,
        cameraEnabled: p.cameraEnabled || false,
        micEnabled: p.micEnabled || false,
        credits:    p.credits,
        seat:       p.seat,
        status:     p.status,
        currentBet: t.betsMade[p.uid] || 0,
        isReady:    p.isReady,
        cardCount:  t.hands[p.uid]?.length || 0,
        hasActed:   t.hasActed[p.uid] || false,
      })),
    };
  }

  getAllTablesPublic() {
    return Object.values(this.tables).map(t => ({
      id:          t.id,
      name:        t.name,
      baseBet:     t.baseBet,
      maxPlayers:  t.maxPlayers,
      minPlayers:  t.minPlayers,
      color:       t.color,
      phase:       t.phase,
      playerCount: t.players.length,
    }));
  }

  _broadcastAllTables() {
    this.io.emit('allTables', this.getAllTablesPublic());
  }

  // ── Player lifecycle ─────────────────────────────────────────────────────────

  joinTable(socket, uid, displayName, photoURL, credits, tableId) {
    // Leave old table first
    if (this.playerTableMap[uid]) this.leaveTable(socket, uid);

    const t = this.tables[tableId];
    if (!t) { socket.emit('gameError', { message: 'Table not found.' }); return; }

    if (t.players.length >= t.maxPlayers) {
      socket.emit('gameError', { message: 'Table is full.' }); return;
    }
    if (t.phase !== PHASE.WAITING) {
      socket.emit('gameError', { message: 'A round is in progress. Please wait.' }); return;
    }
    if (credits < t.baseBet) {
      socket.emit('gameError', { message: `You need at least $${t.baseBet} to join this table.` }); return;
    }

    // Pick lowest free seat number
    const usedSeats = new Set(t.players.map(p => p.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;

    t.players.push({ uid, displayName, photoURL, credits, seat, status: 'waiting', isReady: false, cameraEnabled: false, micEnabled: false, socketId: socket.id });
    this.playerTableMap[uid] = tableId;
    socket.join(tableId);

    socket.emit('joinedTable', { tableId, seat, tableState: this.getPublicTableState(tableId) });
    this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));
    this._broadcastAllTables();
  }

  leaveTable(socket, uid) {
    const tableId = this.playerTableMap[uid];
    if (!tableId) return;
    const t = this.tables[tableId];
    if (!t) return;

    // If mid-game, treat as fold
    if (t.phase === PHASE.BETTING) {
      const p = t.players.find(p => p.uid === uid);
      if (p && p.status === 'active') {
        p.status = 'folded';
        this._checkBettingComplete(tableId);
      }
    }

    t.players = t.players.filter(p => p.uid !== uid);
    ['betsMade', 'hasActed', 'hands', 'evaluations'].forEach(k => delete t[k][uid]);
    delete this.playerTableMap[uid];
    socket.leave(tableId);

    this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));
    this._broadcastAllTables();

    // If too few active players left, abort early
    if (t.phase !== PHASE.WAITING && this._activePlayers(t).length < 1) {
      this._endRoundEarly(tableId);
    }
  }

  updatePlayerSocket(uid, socketId) {
    const tableId = this.playerTableMap[uid];
    if (!tableId) return;
    const p = this.tables[tableId].players.find(p => p.uid === uid);
    if (p) p.socketId = socketId;
  }

  setCameraState(uid, enabled) {
    const tableId = this.playerTableMap[uid];
    if (!tableId) return;
    const table = this.tables[tableId];
    const player = table?.players.find(item => item.uid === uid);
    if (!player) return;
    player.cameraEnabled = Boolean(enabled);
    this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));
  }

  setMicState(uid, enabled) {
    const tableId = this.playerTableMap[uid];
    if (!tableId) return;
    const table = this.tables[tableId];
    const player = table?.players.find(item => item.uid === uid);
    if (!player) return;
    player.micEnabled = Boolean(enabled);
    this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));
  }

  // ── Ready / Countdown ────────────────────────────────────────────────────────

  playerReady(socket, uid) {
    const tableId = this.playerTableMap[uid];
    if (!tableId) return;
    const t = this.tables[tableId];
    if (!t || t.phase !== PHASE.WAITING) return;
    const p = t.players.find(p => p.uid === uid);
    if (!p) return;

    p.isReady = true;
    this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));

    const readyPlayers = t.players.filter(p => p.isReady);
    if (readyPlayers.length >= t.minPlayers && readyPlayers.length === t.players.length) {
      this._startCountdown(tableId);
    }
  }

  _startCountdown(tableId) {
    const t = this.tables[tableId];
    if (t.startCountdown) return;

    let sec = 5;
    this.io.to(tableId).emit('gameCountdown', { seconds: sec });

    t.startCountdown = setInterval(() => {
      sec--;
      const readyCount = t.players.filter(p => p.isReady).length;
      if (readyCount < t.minPlayers) {
        clearInterval(t.startCountdown);
        t.startCountdown = null;
        this.io.to(tableId).emit('gameCountdownCancelled', {});
        return;
      }
      if (sec <= 0) {
        clearInterval(t.startCountdown);
        t.startCountdown = null;
        this._startGame(tableId);
      } else {
        this.io.to(tableId).emit('gameCountdown', { seconds: sec });
      }
    }, 1000);
  }

  // ── Game start / deal ────────────────────────────────────────────────────────

  _startGame(tableId) {
    const t = this.tables[tableId];
    const readyPlayers = t.players.filter(p => p.isReady);
    if (readyPlayers.length < t.minPlayers) return;

    t.phase          = PHASE.DEALING;
    t.pot            = 0;
    t.currentBet     = t.baseBet;
    t.betsMade       = {};
    t.hasActed       = {};
    t.raisedThisRound = false;
    t.hands          = {};
    t.evaluations    = {};

    readyPlayers.forEach(p => { p.status = 'active'; t.betsMade[p.uid] = 0; t.hasActed[p.uid] = false; });
    t.players.filter(p => !p.isReady).forEach(p => { p.status = 'spectating'; });

    this.io.to(tableId).emit('gameStarted', {
      playerCount: readyPlayers.length,
      tableState: this.getPublicTableState(tableId),
    });

    setTimeout(() => this._dealCards(tableId), PRE_DEAL_DELAY_MS);
  }

  _dealCards(tableId) {
    const t = this.tables[tableId];
    let active = this._activePlayers(t);

    // Charge ante
    for (const p of [...active]) {
      if (p.credits < t.baseBet) {
        p.status = 'folded';
        continue;
      }
      p.credits     -= t.baseBet;
      t.betsMade[p.uid] = t.baseBet;
      t.pot         += t.baseBet;
      this._syncCredits(p.uid, p.credits);
    }

    active = this._activePlayers(t);
    if (active.length < 2) { this._endRoundEarly(tableId); return; }

    // Deal 5 cards to each active player
    let hands;
    try {
      ({ hands } = dealHands(active.length));
    } catch (e) {
      console.error('[Deal]', e.message);
      this._endRoundEarly(tableId);
      return;
    }

    active.forEach((p, i) => {
      t.hands[p.uid] = hands[i];
      const sock = this._getSocket(p.socketId);
      if (sock) sock.emit('dealCards', { cards: hands[i], pot: t.pot, baseBet: t.baseBet });
    });

    t.phase = PHASE.BETTING;
    t.dealerIdx = (t.dealerIdx + 1) % active.length;
    t.currentPlayerIdx = (t.dealerIdx + 1) % active.length;

    this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));
    setTimeout(() => this._promptAction(tableId), 800);
  }

  // ── Betting ──────────────────────────────────────────────────────────────────

  _promptAction(tableId) {
    const t      = this.tables[tableId];
    if (t.phase !== PHASE.BETTING) return;
    const active = this._activePlayers(t);
    if (!active.length) { this._endRound(tableId); return; }

    const cp     = active[t.currentPlayerIdx % active.length];
    const toCall = t.currentBet - (t.betsMade[cp.uid] || 0);
    const canRaise  = !t.raisedThisRound;
    const canCheck  = toCall === 0;

    // Broadcast whose turn it is
    this.io.to(tableId).emit('playerTurn', {
      uid: cp.uid,
      timeLimit: ACTION_TIMEOUT_MS / 1000,
      currentBet: t.currentBet,
      toCall,
      canCheck,
      canRaise,
    });

    // Send private action details
    const sock = this._getSocket(cp.socketId);
    if (sock) {
      sock.emit('yourTurn', {
        timeLimit:  ACTION_TIMEOUT_MS / 1000,
        currentBet: t.currentBet,
        toCall,
        canCheck,
        canRaise,
        minRaise:   t.baseBet,
        maxRaise:   Math.max(0, cp.credits - toCall),
      });
    }

    // Auto-fold timer
    this._clearActionTimer(tableId);
    this.actionTimers[tableId] = setTimeout(() => {
      this.handlePlayerAction(tableId, cp.uid, 'fold', 0);
    }, ACTION_TIMEOUT_MS);
  }

  handlePlayerAction(tableId, uid, action, amount = 0) {
    const t = this.tables[tableId];
    if (!t || t.phase !== PHASE.BETTING) return;

    const active = this._activePlayers(t);
    const cp     = active[t.currentPlayerIdx % active.length];
    if (!cp || cp.uid !== uid) return; // not their turn

    this._clearActionTimer(tableId);

    const toCall = t.currentBet - (t.betsMade[uid] || 0);

    switch (action) {
      case 'fold':
        cp.status = 'folded';
        this.io.to(tableId).emit('playerAction', {
          uid, displayName: cp.displayName, action: 'fold',
          message: `${cp.displayName} folded`,
        });
        break;

      case 'check':
      case 'call': {
        const pay = Math.min(toCall, cp.credits);
        cp.credits -= pay;
        t.betsMade[uid] = (t.betsMade[uid] || 0) + pay;
        t.pot += pay;
        t.hasActed[uid] = true;
        this._syncCredits(uid, cp.credits);
        const verb = pay === 0 ? 'checked' : `called $${pay}`;
        this.io.to(tableId).emit('playerAction', {
          uid, displayName: cp.displayName,
          action: pay === 0 ? 'check' : 'call',
          amount: pay,
          message: `${cp.displayName} ${verb}`,
        });
        break;
      }

      case 'raise': {
        if (t.raisedThisRound) {
          // No more raises — treat as call
          this.handlePlayerAction(tableId, uid, 'call', 0); return;
        }
        const raiseBy    = Math.max(t.baseBet, Math.floor(Number(amount) || t.baseBet));
        const totalNeeded = toCall + raiseBy;
        const pay        = Math.min(totalNeeded, cp.credits);

        cp.credits -= pay;
        t.betsMade[uid] = (t.betsMade[uid] || 0) + pay;
        t.pot      += pay;
        t.currentBet = t.betsMade[uid];
        t.raisedThisRound = true;
        t.hasActed[uid] = true;
        this._syncCredits(uid, cp.credits);

        // Reset hasActed for all other active players so they can respond
        const nextActive = this._activePlayers(t);
        nextActive.forEach(p => { if (p.uid !== uid) t.hasActed[p.uid] = false; });

        this.io.to(tableId).emit('playerAction', {
          uid, displayName: cp.displayName, action: 'raise',
          amount: t.currentBet,
          message: `${cp.displayName} raised to $${t.currentBet}`,
        });
        break;
      }

      default:
        console.warn('[Action] Unknown action:', action);
        return;
    }

    this._advanceTurn(tableId);
  }

  _advanceTurn(tableId) {
    const t      = this.tables[tableId];
    const active = this._activePlayers(t);

    if (active.length <= 1) { this._endRound(tableId); return; }

    // Check if betting complete
    if (this._checkBettingComplete(tableId)) return;

    // Advance to next player who still needs to act
    const startIdx = t.currentPlayerIdx;
    for (let i = 1; i <= active.length; i++) {
      const nextIdx = (startIdx + i) % active.length;
      const next    = active[nextIdx];
      const paid    = t.betsMade[next.uid] || 0;
      if (!t.hasActed[next.uid] || paid < t.currentBet) {
        t.currentPlayerIdx = nextIdx;
        this.io.to(tableId).emit('tableUpdate', this.getPublicTableState(tableId));
        this._promptAction(tableId);
        return;
      }
    }

    // All players have acted and bets are equal
    this._endRound(tableId);
  }

  _checkBettingComplete(tableId) {
    const t      = this.tables[tableId];
    const active = this._activePlayers(t);
    if (active.length <= 1) { this._endRound(tableId); return true; }

    const allSettled = active.every(p => {
      const paid = t.betsMade[p.uid] || 0;
      return t.hasActed[p.uid] && paid >= t.currentBet;
    });

    if (allSettled) { this._endRound(tableId); return true; }
    return false;
  }

  // ── Showdown / Payout ────────────────────────────────────────────────────────

  _endRound(tableId) {
    const t      = this.tables[tableId];
    t.phase      = PHASE.SHOWDOWN;
    this._clearActionTimer(tableId);

    const active = this._activePlayers(t);

    if (active.length === 0) { this._resetTable(tableId); return; }

    // One player left (all others folded) — they win without showdown
    if (active.length === 1) {
      this._endRoundEarly(tableId); return;
    }

    // Evaluate all hands
    const playerHands = active.map(p => ({
      uid:  p.uid,
      hand: t.hands[p.uid] || [],
      displayName: p.displayName,
    }));
    playerHands.forEach(ph => {
      ph.evaluation     = evaluateHand(ph.hand);
      t.evaluations[ph.uid] = ph.evaluation;
    });

    const winnerUids = compareHands(playerHands);
    const prize      = Math.floor(t.pot / winnerUids.length);

    t.phase = PHASE.PAYOUT;

    winnerUids.forEach(uid => {
      const p = t.players.find(p => p.uid === uid);
      if (!p) return;
      p.credits += prize;
      this._syncCredits(uid, p.credits);
      this._syncWin(uid);
    });
    active.filter(p => !winnerUids.includes(p.uid)).forEach(p => this._syncLoss(p.uid));

    const results = active.map(p => ({
      uid:        p.uid,
      displayName: p.displayName,
      hand:       t.hands[p.uid] || [],
      evaluation: t.evaluations[p.uid],
      isWinner:   winnerUids.includes(p.uid),
      prize:      winnerUids.includes(p.uid) ? prize : 0,
    }));

    this.io.to(tableId).emit('roundResult', {
      winners:     winnerUids,
      winnerNames: winnerUids.map(uid => t.players.find(p => p.uid === uid)?.displayName || 'Unknown'),
      pot:         t.pot,
      results,
      tableState:  this.getPublicTableState(tableId),
    });

    setTimeout(() => this._resetTable(tableId), PAYOUT_DISPLAY_MS);
  }

  _endRoundEarly(tableId) {
    const t      = this.tables[tableId];
    this._clearActionTimer(tableId);
    t.phase      = PHASE.PAYOUT;

    const active = this._activePlayers(t);
    const winner = active[0];

    if (winner) {
      winner.credits += t.pot;
      this._syncCredits(winner.uid, winner.credits);
      this._syncWin(winner.uid);
    }

    const allActive = t.players.filter(p => ['active', 'folded'].includes(p.status));
    this.io.to(tableId).emit('roundResult', {
      winners:     winner ? [winner.uid] : [],
      winnerNames: winner ? [winner.displayName] : [],
      pot:         t.pot,
      earlyEnd:    true,
      results:     allActive.map(p => ({
        uid:        p.uid,
        displayName: p.displayName,
        hand:       winner?.uid === p.uid ? (t.hands[p.uid] || []) : [],
        evaluation: null,
        isWinner:   winner?.uid === p.uid,
        prize:      winner?.uid === p.uid ? t.pot : 0,
      })),
      tableState: this.getPublicTableState(tableId),
    });

    setTimeout(() => this._resetTable(tableId), PAYOUT_DISPLAY_MS);
  }

  _resetTable(tableId) {
    const t      = this.tables[tableId];
    t.phase      = PHASE.WAITING;
    t.pot        = 0;
    t.currentBet = 0;
    t.currentPlayerIdx = 0;
    t.hands      = {};
    t.evaluations = {};
    t.betsMade   = {};
    t.hasActed   = {};
    t.raisedThisRound = false;

    t.players.forEach(p => { p.status = 'waiting'; p.isReady = false; });

    this.io.to(tableId).emit('tableReset', this.getPublicTableState(tableId));
    this._broadcastAllTables();
  }
}

module.exports = { GameManager, TABLE_CONFIGS };
