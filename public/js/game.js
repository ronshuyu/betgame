/* ════════════════════════════════════════════════════════════════
   BETGAME — game.js
   Handles: Socket.io, card rendering, table layout, betting UI
   ════════════════════════════════════════════════════════════════ */

/* ── Constants ──────────────────────────────────────────────────── */
const SUIT_COLORS = { hearts: 'red', diamonds: 'red', spades: 'black', clubs: 'black' };

// 12 seat positions (% of table width/height), seat 0 = south (self)
const SEAT_POSITIONS = [
  { x: 50,  y: 82  },  // 0 — south (self)
  { x: 22,  y: 102 },  // 1 — south-west
  { x: 4,   y: 80  },  // 2 — west
  { x: 6,   y: 48  },  // 3 — north-west
  { x: 18,  y: 20  },  // 4 — north-north-west
  { x: 38,  y: 6   },  // 5 — north
  { x: 62,  y: 6   },  // 6 — north
  { x: 82,  y: 20  },  // 7 — north-north-east
  { x: 94,  y: 48  },  // 8 — north-east
  { x: 96,  y: 80  },  // 9 — east
  { x: 78,  y: 102 },  // 10 — south-east
  { x: 50,  y: 116 },  // 11 — south (extra)
];

/* ── State ──────────────────────────────────────────────────────── */
const G = {
  socket:       null,
  tableId:      null,
  mySeat:       null,
  myCards:      [],
  tableState:   null,
  isMyTurn:     false,
  canCheck:     false,
  canRaise:     false,
  toCall:       0,
  minRaise:     5,
  maxRaise:     0,
  timerInterval: null,
  timerTotal:   30,
  cameraStream: null,
  micStream: null,
  peerConnections: new Map(),
  remoteStreams: new Map(),
  pendingCandidates: new Map(),
};

/* ── Socket connection ──────────────────────────────────────────── */

function connectSocket() {
  const socketToken = sessionStorage.getItem('betgame_token');
  if (!socketToken) { window.location.href = '/'; return; }

  G.socket = io('https://betgame-tsm2.onrender.com', {
    auth: { token: socketToken },
    reconnection: true,
    reconnectionDelay: 1500,
  });

  G.socket.on('connect', () => {
    console.log('[Socket] Connected:', G.socket.id);
    if (G.tableId) {
      G.socket.emit('joinTable', { tableId: G.tableId });
    }
  });

  G.socket.on('connect_error', (err) => {
    console.error('[Socket] Connect error:', err.message);
    showToast('Connection error: ' + err.message, 'error');
  });

  G.socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected:', reason);
    showToast('Disconnected from server. Reconnecting…', 'error');
  });

  // ── Game events ──
  G.socket.on('allTables',          onAllTables);
  G.socket.on('joinedTable',        onJoinedTable);
  G.socket.on('tableUpdate',        onTableUpdate);
  G.socket.on('gameStarted',        onGameStarted);
  G.socket.on('gameCountdown',      onGameCountdown);
  G.socket.on('gameCountdownCancelled', () => hideOverlay('countdown-overlay'));
  G.socket.on('dealCards',          onDealCards);
  G.socket.on('playerTurn',         onPlayerTurn);
  G.socket.on('yourTurn',           onYourTurn);
  G.socket.on('playerAction',       onPlayerAction);
  G.socket.on('roundResult',        onRoundResult);
  G.socket.on('tableReset',         onTableReset);
  G.socket.on('gameError',          ({ message }) => showToast(message, 'error'));
  G.socket.on('camera:signal',      onCameraSignal);
}

/* ── Socket event handlers ──────────────────────────────────────── */

function onAllTables(tables) {
  if (typeof renderTables === 'function') renderTables(tables);
}

function onJoinedTable({ tableId, seat, tableState }) {
  G.tableId  = tableId;
  G.mySeat   = seat;
  G.myCards  = [];
  showGameView();
  renderTableState(tableState);
  syncCameraPeers(tableState);
  if (G.cameraStream) G.socket?.emit('camera:state', { enabled: true });
  if (G.micStream) G.socket?.emit('mic:state', { enabled: true });
  showWaitingRoom(tableState);
  document.getElementById('leave-table-btn').style.display = '';
}

function onTableUpdate(tableState) {
  G.tableState = tableState;
  renderTableState(tableState);
  syncCameraPeers(tableState);
  if (tableState.phase === 'WAITING') showWaitingRoom(tableState);
}

function onGameStarted({ playerCount }) {
  showToast(`🎮 Game starting with ${playerCount} players!`, 'info');
  hideWaitingRoom();
  setActionPhase('DEALING', 'Dealing cards…');
}

function onGameCountdown({ seconds }) {
  const overlay  = document.getElementById('countdown-overlay');
  const numEl    = document.getElementById('countdown-number');
  overlay.classList.remove('hidden');
  numEl.textContent = seconds;
  // Re-trigger animation
  numEl.style.animation = 'none';
  numEl.offsetHeight; // reflow
  numEl.style.animation = '';
  if (seconds === 1) {
    setTimeout(() => overlay.classList.add('hidden'), 950);
  }
}

function onDealCards({ cards, pot, baseBet }) {
  G.myCards = cards;
  renderMyHand(cards);
  updatePot(pot);
  setActionPhase('BETTING', `Pot: $${pot} | Base bet: $${baseBet}`);
}

function onPlayerTurn({ uid, timeLimit, toCall, canCheck, canRaise }) {
  const myUid = sessionStorage.getItem('betgame_uid');
  if (uid !== myUid) {
    // Another player's turn — show in UI
    const player = G.tableState?.players?.find(p => p.uid === uid);
    if (player) setActionContext(`⏳ ${player.displayName}'s turn…`);
    highlightActiveSeat(uid);
  }
}

function onYourTurn({ timeLimit, currentBet, toCall, canCheck, canRaise, minRaise, maxRaise }) {
  G.isMyTurn  = true;
  G.canCheck  = canCheck;
  G.canRaise  = canRaise;
  G.toCall    = toCall;
  G.minRaise  = minRaise;
  G.maxRaise  = maxRaise;

  showActionButtons(toCall, canCheck, canRaise, minRaise, maxRaise);
  startTurnTimer(timeLimit);
  showToast('🎯 Your turn!', 'gold', 2000);
}

function onPlayerAction({ uid, displayName, action, amount, message }) {
  addActionFeed(message, action);
  // Update turn indicator
  if (G.tableState) {
    highlightActiveSeat(uid);
  }
}

function onRoundResult({ winners, winnerNames, pot, results, earlyEnd }) {
  stopTurnTimer();
  hideActionButtons();
  updatePot(pot);

  // Reveal hands if showdown (not early end)
  if (!earlyEnd && results) {
    results.forEach(r => {
      if (r.hand && r.hand.length > 0) {
        revealSeatHand(r.uid, r.hand, r.isWinner);
      }
    });
  }

  // Show winner overlay after a brief pause
  setTimeout(() => showWinnerOverlay(winners, winnerNames, pot, results, earlyEnd), 800);
}

function onTableReset(tableState) {
  G.myCards  = [];
  G.isMyTurn = false;
  stopTurnTimer();
  hideActionButtons();
  hideWaitingRoom();
  clearMyHand();
  clearSeatHands();
  updatePot(0);
  renderTableState(tableState);
  showWaitingRoom(tableState);
  setActionPhase('WAITING', 'Waiting for the next round…');
  showToast('Round over — click Ready for the next round!', 'info');
}

/* ── Table join flow ─────────────────────────────────────────────── */

function joinTableById(tableId) {
  if (!G.socket) return;
  G.tableId = tableId;
  G.socket.emit('joinTable', { tableId });
}
window.joinTableById = joinTableById;

function leaveTable() {
  if (!G.socket) return;
  G.socket.emit('leaveTable');
  stopCamera();
  G.micStream?.getTracks().forEach(track => track.stop());
  G.micStream = null;
  closeCameraPeers();
  updateCameraButton(false);
  cameraStatus('Camera off');
  updateMicButton(false);
  G.tableId = null;
  G.mySeat  = null;
  G.myCards = [];
  showLobbyView();
  document.getElementById('leave-table-btn').style.display = 'none';
}

/* ── View switching ─────────────────────────────────────────────── */

function showLobbyView() {
  document.getElementById('lobby-view').classList.remove('hidden');
  document.getElementById('game-view').classList.add('hidden');
}

function showGameView() {
  document.getElementById('lobby-view').classList.add('hidden');
  document.getElementById('game-view').classList.remove('hidden');
}

/* ── Table state rendering ──────────────────────────────────────── */

function renderTableState(state) {
  if (!state) return;
  G.tableState = state;

  updatePot(state.pot || 0);
  setActionPhase(state.phase, getPhaseDescription(state));
  renderSeats(state.players, state.currentPlayerIdx, state);
}

function getPhaseDescription(state) {
  switch (state.phase) {
    case 'WAITING':  return `Waiting for players (${state.players.filter(p=>p.isReady).length}/${state.players.length} ready)`;
    case 'DEALING':  return 'Dealing cards…';
    case 'BETTING':  return `Pot: $${state.pot} | Current bet: $${state.currentBet}`;
    case 'SHOWDOWN': return 'Showdown!';
    case 'PAYOUT':   return 'Paying out…';
    default:         return '';
  }
}

/* ── Seat rendering ─────────────────────────────────────────────── */

function renderSeats(players, currentPlayerIdx, state) {
  const container = document.getElementById('seats-container');
  if (!container) return;

  const myUid      = sessionStorage.getItem('betgame_uid');
  const myIdx      = players.findIndex(p => p.uid === myUid);
  const activePlayers = players.filter(p => ['active'].includes(p.status));
  const currentUid = activePlayers[currentPlayerIdx % Math.max(1, activePlayers.length)]?.uid;

  container.innerHTML = '';

  players.forEach((player, idx) => {
    // Remap seats so local player is always at position 0
    const relIdx  = myIdx >= 0 ? (idx - myIdx + players.length) % players.length : idx;
    const pos     = SEAT_POSITIONS[Math.min(relIdx, SEAT_POSITIONS.length - 1)];
    const isSelf  = player.uid === myUid;
    const isTurn  = player.uid === currentUid && state.phase === 'BETTING';
    const isWin   = false; // set during showdown

    const seat    = document.createElement('div');
    seat.className  = `seat ${isSelf ? 'is-self' : ''} ${isTurn ? 'is-turn' : ''} ${player.status === 'folded' ? 'folded' : ''}`;
    seat.id         = `seat-${player.uid}`;
    seat.style.cssText = `left:${pos.x}%; top:${pos.y}%;`;

    const initial = (player.displayName || 'P')[0].toUpperCase();
    const avatarHTML = player.photoURL
      ? `<img class="seat-avatar" src="${player.photoURL}" alt="${player.displayName}">`
      : `<div class="seat-avatar-fallback">${initial}</div>`;
    const cameraHTML = `<video class="seat-camera" data-camera-uid="${player.uid}" autoplay playsinline muted></video>`;

    const readyBadge = player.isReady && state.phase === 'WAITING'
      ? '<div class="ready-badge">✓</div>' : '';

    seat.innerHTML = `
      <div class="seat-avatar-wrap">
        ${avatarHTML}
        ${cameraHTML}
        <div class="seat-status-dot ${player.status}"></div>
        ${readyBadge}
      </div>
      <div class="seat-hand" id="seat-hand-${player.uid}">
        ${renderSeatCards(player, isSelf, state)}
      </div>
      <div class="seat-name" title="${player.displayName}">${isSelf ? '(You) ' : ''}${player.displayName}</div>
      <div class="seat-credits">$${player.credits}</div>
      ${player.currentBet > 0 ? `<div class="seat-bet">Bet: $${player.currentBet}</div>` : ''}
    `;

    const avatarImage = seat.querySelector('.seat-avatar');
    avatarImage?.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'seat-avatar-fallback';
      fallback.textContent = initial;
      avatarImage.replaceWith(fallback);
    }, { once: true });

    container.appendChild(seat);
  });

  attachCameraVideos(container);
}

/* ── In-game camera ─────────────────────────────────────────────── */

const CAMERA_PEER_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function cameraStatus(message) {
  const status = document.getElementById('camera-status');
  if (status) status.textContent = message;
}

function updateCameraButton(enabled) {
  const button = document.getElementById('camera-toggle');
  if (!button) return;
  button.textContent = enabled ? 'Turn camera off' : 'Enable camera';
  button.setAttribute('aria-pressed', String(enabled));
}

function updateMicButton(enabled) {
  const button = document.getElementById('mic-toggle');
  if (!button) return;
  button.textContent = enabled ? 'Mute mic' : 'Enable mic';
  button.setAttribute('aria-pressed', String(enabled));
  const status = document.getElementById('mic-status');
  if (status) status.textContent = enabled ? 'Mic on' : 'Mic off';
}

async function toggleCamera() {
  if (G.cameraStream) {
    stopCamera();
    if (G.socket) G.socket.emit('camera:state', { enabled: false });
    updateCameraButton(false);
    cameraStatus('Camera off');
    renderTableState(G.tableState);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Camera access requires a secure connection and a supported browser.', 'error');
    return;
  }

  const button = document.getElementById('camera-toggle');
  if (button) button.disabled = true;
  cameraStatus('Requesting camera…');
  try {
    G.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    updateCameraButton(true);
    cameraStatus('Camera on');
    if (G.socket) G.socket.emit('camera:state', { enabled: true });
    renderTableState(G.tableState);
    syncCameraPeers(G.tableState);
    await updatePeerTrack('video', G.cameraStream.getVideoTracks()[0]);
  } catch (error) {
    G.cameraStream = null;
    cameraStatus('Camera off');
    showToast(error.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Could not start the camera.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function stopCamera() {
  if (G.cameraStream) {
    G.cameraStream.getTracks().forEach(track => track.stop());
    G.cameraStream = null;
  }
  updatePeerTrack('video', null).catch(() => {});
}

async function toggleMic() {
  if (G.micStream) {
    G.micStream.getTracks().forEach(track => track.stop());
    G.micStream = null;
    await updatePeerTrack('audio', null);
    G.socket?.emit('mic:state', { enabled: false });
    updateMicButton(false);
    syncCameraPeers(G.tableState);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('Microphone access requires a secure connection and a supported browser.', 'error');
    return;
  }

  const button = document.getElementById('mic-toggle');
  if (button) button.disabled = true;
  const status = document.getElementById('mic-status');
  if (status) status.textContent = 'Requesting mic…';
  try {
    G.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    G.socket?.emit('mic:state', { enabled: true });
    updateMicButton(true);
    syncCameraPeers(G.tableState);
    await updatePeerTrack('audio', G.micStream.getAudioTracks()[0]);
  } catch (error) {
    G.micStream?.getTracks().forEach(track => track.stop());
    G.micStream = null;
    updateMicButton(false);
    showToast(error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Could not start the microphone.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function updatePeerTrack(kind, track) {
  await Promise.all([...G.peerConnections.values()].map(connection => {
    const transceiver = connection.getTransceivers().find(item => item.receiver.track.kind === kind);
    return transceiver ? transceiver.sender.replaceTrack(track) : Promise.resolve();
  }));
}

function closeCameraPeers() {
  for (const connection of G.peerConnections.values()) connection.close();
  G.peerConnections.clear();
  G.remoteStreams.clear();
  G.pendingCandidates.clear();
}

function syncCameraPeers(state) {
  if (!state || !G.socket) return;
  const myUid = sessionStorage.getItem('betgame_uid');
  const players = state.players || [];
  const playersByUid = new Map(players.map(player => [player.uid, player]));
  for (const [uid, connection] of G.peerConnections) {
    const player = playersByUid.get(uid);
    if (!player || (!player.cameraEnabled && !player.micEnabled && !G.cameraStream && !G.micStream)) {
      connection.close();
      G.peerConnections.delete(uid);
      G.remoteStreams.delete(uid);
      G.pendingCandidates.delete(uid);
    }
  }
  for (const player of players) {
    if (player.uid === myUid) continue;
    if (player.cameraEnabled || player.micEnabled || G.cameraStream || G.micStream) {
      const connection = getCameraPeer(player.uid);
      if (myUid.localeCompare(player.uid) < 0 && connection.signalingState === 'stable' && !connection.makingOffer) {
        connection.makingOffer = true;
        connection.createOffer()
          .then(offer => connection.setLocalDescription(offer))
          .then(() => sendCameraSignal(player.uid, { type: 'description', description: connection.localDescription }))
          .catch(error => console.warn('[Camera] Could not create offer:', error.message))
          .finally(() => { connection.makingOffer = false; });
      }
    }
  }
}

function getCameraPeer(uid) {
  if (G.peerConnections.has(uid)) return G.peerConnections.get(uid);
  const connection = new RTCPeerConnection(CAMERA_PEER_CONFIG);
  connection.addTransceiver('video', { direction: 'sendrecv' });
  connection.addTransceiver('audio', { direction: 'sendrecv' });
  if (G.cameraStream) {
    const videoTrack = G.cameraStream.getVideoTracks()[0];
    connection.getTransceivers().find(item => item.receiver.track.kind === 'video')?.sender.replaceTrack(videoTrack);
  }
  if (G.micStream) {
    const audioTrack = G.micStream.getAudioTracks()[0];
    connection.getTransceivers().find(item => item.receiver.track.kind === 'audio')?.sender.replaceTrack(audioTrack);
  }
  connection.ontrack = event => {
    const stream = G.remoteStreams.get(uid) || new MediaStream();
    const incomingTracks = event.streams[0]?.getTracks() || [event.track];
    incomingTracks.forEach(track => {
      if (!stream.getTracks().some(existing => existing.id === track.id)) stream.addTrack(track);
    });
    G.remoteStreams.set(uid, stream);
    attachCameraVideo(uid);
  };
  connection.onicecandidate = event => {
    if (event.candidate) sendCameraSignal(uid, { type: 'candidate', candidate: event.candidate });
  };
  G.peerConnections.set(uid, connection);
  return connection;
}

function sendCameraSignal(toUid, signal) {
  G.socket?.emit('camera:signal', { toUid, signal });
}

async function onCameraSignal({ fromUid, signal }) {
  if (!fromUid || !signal) return;
  const connection = getCameraPeer(fromUid);
  try {
    if (signal.type === 'description' && signal.description) {
      await connection.setRemoteDescription(signal.description);
      await applyPendingCandidates(fromUid, connection);
      if (signal.description.type === 'offer') {
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        sendCameraSignal(fromUid, { type: 'description', description: connection.localDescription });
      }
    } else if (signal.type === 'candidate' && signal.candidate) {
      if (connection.remoteDescription) {
        await connection.addIceCandidate(signal.candidate);
      } else {
        const candidates = G.pendingCandidates.get(fromUid) || [];
        candidates.push(signal.candidate);
        G.pendingCandidates.set(fromUid, candidates);
      }
    }
  } catch (error) {
    console.warn('[Camera] Signaling failed:', error.message);
  }
}

async function applyPendingCandidates(uid, connection) {
  const candidates = G.pendingCandidates.get(uid) || [];
  G.pendingCandidates.delete(uid);
  for (const candidate of candidates) await connection.addIceCandidate(candidate);
}

function attachCameraVideos(container = document) {
  container.querySelectorAll('video[data-camera-uid]').forEach(video => {
    video.addEventListener('playing', () => video.classList.toggle('is-live', video.videoWidth > 0));
    video.addEventListener('loadeddata', () => video.classList.toggle('is-live', video.videoWidth > 0));
    video.addEventListener('pause', () => video.classList.remove('is-live'));
    video.addEventListener('error', () => video.classList.remove('is-live'));
    const uid = video.dataset.cameraUid;
    const stream = uid === sessionStorage.getItem('betgame_uid')
      ? G.cameraStream
      : G.remoteStreams.get(uid);
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.muted = uid === sessionStorage.getItem('betgame_uid');
      video.play().catch(() => {});
    }
  });
}

function attachCameraVideo(uid) {
  const video = document.querySelector(`video[data-camera-uid="${CSS.escape(uid)}"]`);
  const stream = G.remoteStreams.get(uid);
  if (video && stream) {
    video.addEventListener('playing', () => video.classList.toggle('is-live', video.videoWidth > 0));
    video.addEventListener('loadeddata', () => video.classList.toggle('is-live', video.videoWidth > 0));
    video.addEventListener('pause', () => video.classList.remove('is-live'));
    video.addEventListener('error', () => video.classList.remove('is-live'));
    video.srcObject = stream;
    video.muted = uid === sessionStorage.getItem('betgame_uid');
    video.play().catch(() => {});
  }
}

function renderSeatCards(player, isSelf, state) {
  const count = player.cardCount || 0;
  if (count === 0) return '';

  if (isSelf) {
    // My cards shown as face-up (rendered separately in #my-hand-area)
    return '';
  }

  // Opponents: show face-down cards
  return Array(count).fill(0).map(() => makeCardHTML(null, null, false)).join('');
}

/* ── Card HTML builders ─────────────────────────────────────────── */

function makeCardHTML(rank, suit, faceUp, animate = false) {
  const colorClass = suit ? (SUIT_COLORS[suit] || 'black') : 'black';
  const symbol     = suit ? getSuitSymbol(suit) : '?';
  const dealClass  = animate ? ' dealing' : '';

  if (!faceUp || !rank) {
    // Face-down card
    return `
      <div class="playing-card${dealClass}">
        <div class="card-inner">
          <div class="card-face ${colorClass}" style="transform:rotateY(180deg); backface-visibility:hidden; -webkit-backface-visibility:hidden;"></div>
          <div class="card-back-face">
            <div class="card-back-pattern"></div>
            <div class="card-back-logo">BG</div>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="playing-card${dealClass}">
      <div class="card-inner">
        <div class="card-face ${colorClass}">
          <div class="card-corner">
            <div class="card-rank">${rank}</div>
            <div class="card-suit-sm">${symbol}</div>
          </div>
          <div class="card-center-suit">${symbol}</div>
          <div class="card-corner bottom">
            <div class="card-rank">${rank}</div>
            <div class="card-suit-sm">${symbol}</div>
          </div>
        </div>
        <div class="card-back-face">
          <div class="card-back-pattern"></div>
          <div class="card-back-logo">BG</div>
        </div>
      </div>
    </div>`;
}

function getSuitSymbol(suit) {
  const map = { hearts:'♥', diamonds:'♦', spades:'♠', clubs:'♣' };
  return map[suit] || suit;
}

/* ── My hand rendering ───────────────────────────────────────────── */

function renderMyHand(cards) {
  const area = document.getElementById('my-hand-area');
  if (!area) return;
  area.innerHTML = '';

  cards.forEach((card, i) => {
    const html = makeCardHTML(card.rank, card.suit, true, true);
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const el = wrap.firstElementChild;
    el.style.animationDelay = `${i * 0.12}s`;
    area.appendChild(el);
  });
}

function clearMyHand() {
  const area = document.getElementById('my-hand-area');
  if (area) area.innerHTML = '';
}

function clearSeatHands() {
  document.querySelectorAll('[id^="seat-hand-"]').forEach(el => el.innerHTML = '');
}

/* ── Reveal opponent hands at showdown ───────────────────────────── */

function revealSeatHand(uid, cards, isWinner) {
  const myUid  = sessionStorage.getItem('betgame_uid');
  if (uid === myUid) {
    // Animate own cards as winner
    if (isWinner) {
      document.querySelectorAll('#my-hand-area .playing-card').forEach(c => c.classList.add('winner'));
    }
    return;
  }

  const handEl = document.getElementById(`seat-hand-${uid}`);
  if (!handEl) return;

  handEl.innerHTML = cards.map(c => makeCardHTML(c.rank, c.suit, true, false)).join('');

  const seatEl = document.getElementById(`seat-${uid}`);
  if (seatEl && isWinner) seatEl.classList.add('winner');
}

/* ── Pot / Phase UI ─────────────────────────────────────────────── */

function updatePot(amount) {
  const el = document.getElementById('pot-amount');
  if (el) el.textContent = `$${amount}`;
}

function setActionPhase(phase, context = '') {
  const phaseEl   = document.getElementById('action-phase');
  const contextEl = document.getElementById('action-context');
  if (phaseEl)   phaseEl.textContent   = phase;
  if (contextEl) contextEl.innerHTML   = context.replace(/\$(\d+)/g, '<span class="highlight">$$$1</span>');
}

function setActionContext(context) {
  const el = document.getElementById('action-context');
  if (el) el.innerHTML = context.replace(/\$(\d+)/g, '<span class="highlight">$$$1</span>');
}

/* ── Waiting room ───────────────────────────────────────────────── */

function showWaitingRoom(state) {
  const wr = document.getElementById('waiting-room');
  if (!wr) return;

  const readyCount = state.players.filter(p => p.isReady).length;
  const total      = state.players.length;
  const min        = state.minPlayers || 2;

  document.getElementById('waiting-count').textContent = `${readyCount}/${Math.max(total, min)}`;

  const myUid   = sessionStorage.getItem('betgame_uid');
  const me      = state.players.find(p => p.uid === myUid);
  const readyBtn = document.getElementById('ready-btn');

  if (me?.isReady) {
    readyBtn.disabled   = true;
    readyBtn.textContent = '✓ Ready!';
  } else {
    readyBtn.disabled    = false;
    readyBtn.textContent = '✓ Ready';
  }

  wr.style.display = state.phase === 'WAITING' ? '' : 'none';
}

function hideWaitingRoom() {
  const wr = document.getElementById('waiting-room');
  if (wr) wr.style.display = 'none';
}

/* ── Betting UI ─────────────────────────────────────────────────── */

function showActionButtons(toCall, canCheck, canRaise, minRaise, maxRaise) {
  const btns = document.getElementById('action-buttons');
  if (!btns) return;
  btns.classList.remove('hidden');

  // Call button
  const callBtn  = document.getElementById('btn-call');
  const callAmt  = document.getElementById('call-amount');
  const checkBtn = document.getElementById('btn-check');

  if (canCheck) {
    callBtn.style.display  = 'none';
    checkBtn.style.display = '';
  } else {
    callBtn.style.display  = '';
    checkBtn.style.display = 'none';
    callAmt.textContent    = toCall;
    callBtn.disabled       = toCall <= 0;
  }

  // Raise
  const raiseWrap = document.getElementById('raise-wrap');
  const raiseBtn  = document.getElementById('btn-raise');
  const raiseInput = document.getElementById('raise-amount-input');

  raiseWrap.style.display = canRaise ? '' : 'none';
  raiseBtn.style.display  = canRaise ? '' : 'none';

  if (canRaise && raiseInput) {
    raiseInput.min   = minRaise;
    raiseInput.max   = maxRaise;
    raiseInput.value = minRaise;
  }
}

function hideActionButtons() {
  const btns = document.getElementById('action-buttons');
  if (btns) btns.classList.add('hidden');
  stopTurnTimer();
}

function sendAction(action, amount = 0) {
  if (!G.socket || !G.isMyTurn) return;
  G.socket.emit('playerAction', { action, amount });
  G.isMyTurn = false;
  hideActionButtons();
  stopTurnTimer();
}

/* ── Turn timer ─────────────────────────────────────────────────── */

function startTurnTimer(totalSeconds) {
  G.timerTotal = totalSeconds;
  stopTurnTimer();

  const timerEl = document.getElementById('turn-timer');
  const ringEl  = document.getElementById('timer-ring');
  const valEl   = document.getElementById('timer-val');

  if (!timerEl) return;
  timerEl.classList.remove('hidden');

  let remaining = totalSeconds;

  function tick() {
    if (valEl) valEl.textContent = remaining;
    const pct = (remaining / totalSeconds) * 100;
    if (ringEl) {
      ringEl.style.setProperty('--progress', `${pct}%`);
      ringEl.classList.toggle('urgent', remaining <= 10);
    }
  }

  tick();
  G.timerInterval = setInterval(() => {
    remaining--;
    tick();
    if (remaining <= 0) stopTurnTimer();
  }, 1000);
}

function stopTurnTimer() {
  if (G.timerInterval) {
    clearInterval(G.timerInterval);
    G.timerInterval = null;
  }
  const timerEl = document.getElementById('turn-timer');
  if (timerEl) timerEl.classList.add('hidden');
}

/* ── Seat highlights ─────────────────────────────────────────────── */

function highlightActiveSeat(uid) {
  document.querySelectorAll('.seat.is-turn').forEach(el => el.classList.remove('is-turn'));
  const seat = document.getElementById(`seat-${uid}`);
  if (seat) seat.classList.add('is-turn');
}

/* ── Action feed ──────────────────────────────────────────────────── */

function addActionFeed(message, actionType = '') {
  const feed = document.getElementById('action-feed');
  if (!feed) return;

  const item = document.createElement('div');
  item.className = `feed-item action-${actionType.toLowerCase()}`;
  item.textContent = message;
  feed.appendChild(item);

  // Limit to 5 items
  while (feed.children.length > 5) feed.removeChild(feed.firstChild);

  // Auto-remove after animation
  setTimeout(() => item.remove(), 4200);
}

/* ── Winner overlay ───────────────────────────────────────────────── */

function showWinnerOverlay(winners, winnerNames, pot, results, earlyEnd) {
  const overlay = document.getElementById('winner-overlay');
  const card    = document.getElementById('winner-card');
  if (!overlay || !card) return;

  const myUid = sessionStorage.getItem('betgame_uid');
  const iWon  = winners.includes(myUid);
  const name  = winnerNames.join(' & ');

  const myResult    = results?.find(r => r.uid === myUid);
  const winnerResult = results?.find(r => winners.includes(r.uid));

  let handDisplay = '';
  if (!earlyEnd && winnerResult?.evaluation) {
    handDisplay = `<div class="winner-hand">${winnerResult.evaluation.name}</div>`;
    if (winnerResult.hand?.length) {
      const cardHTML = winnerResult.hand.map(c => makeCardHTML(c.rank, c.suit, true)).join('');
      handDisplay += `<div class="result-cards">${cardHTML}</div>`;
    }
  }

  // Update my credits
  if (myResult) {
    window.updateHUDCredits(myResult.isWinner
      ? (playerProfile?.credits || 500) + myResult.prize
      : playerProfile?.credits || 500);
  }

  card.innerHTML = `
    <div class="winner-crown">${iWon ? '👑' : '🃏'}</div>
    <div class="winner-title">${earlyEnd ? 'Round Over' : 'Showdown!'}</div>
    <div class="winner-name">${name} wins!</div>
    ${handDisplay}
    <div class="winner-prize">🏆 +$${pot}</div>
    ${iWon ? '<div style="color:var(--success);font-size:1rem;margin-top:.5rem">You won this round! 🎉</div>' : `<div style="color:var(--text-muted);font-size:0.88rem;margin-top:.5rem">Better luck next round!</div>`}
    <div style="margin-top:1.5rem">
      ${results?.map(r => `
        <div class="result-row ${r.isWinner ? 'winner-row' : ''} ${r.hand?.length === 0 ? 'folded-row' : ''}">
          <span>${r.displayName}</span>
          <span>${r.evaluation ? r.evaluation.name : (r.isWinner ? 'Winner' : 'Folded')}</span>
          <span style="color:${r.isWinner ? 'var(--success)' : 'var(--danger)'}">${r.isWinner ? '+$'+r.prize : '-'}</span>
        </div>`).join('') || ''}
    </div>
  `;

  overlay.classList.remove('hidden');

  // Auto-dismiss after 5s
  setTimeout(() => overlay.classList.add('hidden'), 5500);
}

/* ── Misc overlays ────────────────────────────────────────────────── */

function hideOverlay(id) {
  document.getElementById(id)?.classList.add('hidden');
}

/* ── Credits sync ─────────────────────────────────────────────────── */

window.onCreditsUpdated = function (credits) {
  window.updateHUDCredits(credits);
  if (G.tableState) {
    const myUid = sessionStorage.getItem('betgame_uid');
    const p = G.tableState.players?.find(p => p.uid === myUid);
    if (p) p.credits = credits;
  }
};

/* ── DOM bindings ─────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  // Start socket connection
  connectSocket();

  // Leave table button
  document.getElementById('leave-table-btn')?.addEventListener('click', leaveTable);
  document.getElementById('camera-toggle')?.addEventListener('click', toggleCamera);
  document.getElementById('mic-toggle')?.addEventListener('click', toggleMic);

  // Ready button
  document.getElementById('ready-btn')?.addEventListener('click', () => {
    if (G.socket) G.socket.emit('playerReady');
    document.getElementById('ready-btn').disabled   = true;
    document.getElementById('ready-btn').textContent = '✓ Ready!';
  });

  // Betting action buttons
  document.getElementById('btn-fold')?.addEventListener('click', () => sendAction('fold'));

  document.getElementById('btn-check')?.addEventListener('click', () => sendAction('check'));

  document.getElementById('btn-call')?.addEventListener('click', () => sendAction('call'));

  document.getElementById('btn-raise')?.addEventListener('click', () => {
    const input  = document.getElementById('raise-amount-input');
    const amount = parseInt(input?.value || G.minRaise, 10);
    if (isNaN(amount) || amount < G.minRaise) {
      showToast(`Minimum raise is $${G.minRaise}`, 'error', 2000);
      return;
    }
    if (amount > G.maxRaise && G.maxRaise > 0) {
      showToast(`Maximum raise is $${G.maxRaise}`, 'error', 2000);
      return;
    }
    sendAction('raise', amount);
  });

  // Close winner overlay on click
  document.getElementById('winner-overlay')?.addEventListener('click', () => {
    document.getElementById('winner-overlay').classList.add('hidden');
  });
});
