/* ════════════════════════════════════════════════════════════════
   BETGAME — lobby.js
   Handles: auth guard, HUD, tables list, top-up modal
   ════════════════════════════════════════════════════════════════ */

// ── Auth guard ───────────────────────────────────────────────────
const token = sessionStorage.getItem('betgame_token');
const uid   = sessionStorage.getItem('betgame_uid');
if (!token || !uid) {
  window.location.href = '/';
}

// ── HUD bootstrap ────────────────────────────────────────────────

let playerProfile = null;

async function loadPlayerProfile() {
  try {
    const res = await fetch(`https://betgame-tsm2.onrender.com/api/player/${uid}`);
    if (!res.ok) throw new Error('Profile not found');
    playerProfile = await res.json();
    renderHUD(playerProfile);
  } catch (e) {
    console.warn('[Lobby] Could not load profile:', e.message);
    // Fallback: use session data
    renderHUD({
      displayName: sessionStorage.getItem('betgame_name') || 'Player',
      photoURL:    sessionStorage.getItem('betgame_photo') || '',
      credits:     500,
      wins:        0,
      losses:      0,
    });
  }
}

function renderHUD(p) {
  document.getElementById('hud-name').textContent    = p.displayName || 'Player';
  document.getElementById('hud-credits').textContent = `$${p.credits ?? 500}`;
  document.getElementById('hud-wins').textContent    = p.wins    || 0;
  document.getElementById('hud-losses').textContent  = p.losses  || 0;

  // Avatar
  const wrap = document.getElementById('hud-avatar-wrap');
  const fallback = document.getElementById('hud-avatar-fallback');
  if (p.photoURL) {
    const img = document.createElement('img');
    img.src       = p.photoURL;
    img.alt       = p.displayName;
    img.className = 'hud-avatar';
    img.onerror   = () => { wrap.innerHTML = `<div class="hud-avatar-fallback">${(p.displayName||'P')[0].toUpperCase()}</div>`; };
    wrap.innerHTML = '';
    wrap.appendChild(img);
  } else {
    fallback.textContent = (p.displayName || 'P')[0].toUpperCase();
  }
}

function updateHUDCredits(credits) {
  document.getElementById('hud-credits').textContent = `$${credits}`;
  if (playerProfile) playerProfile.credits = credits;
}

// ── Tables rendering ─────────────────────────────────────────────

function renderTables(tables) {
  const grid = document.getElementById('tables-grid');
  if (!grid) return;

  grid.innerHTML = tables.map(t => {
    const isFull       = t.playerCount >= t.maxPlayers;
    const inProgress   = t.phase !== 'WAITING';
    const canJoin      = !isFull && !inProgress;
    const countClass   = t.playerCount > 0 ? '' : 'empty';
    const statusLabel  = inProgress ? 'In Progress' : 'Waiting';
    const statusClass  = inProgress ? 'in-progress' : 'waiting';

    return `
      <div class="table-card">
        <div class="table-card-top">
          <span class="table-card-index">TABLE / 0${t.id.slice(-1)}</span>
          <span class="table-status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="table-card-name">${t.name}</div>
        <div class="table-card-stake">$${t.baseBet} <span>entry bet</span></div>
        <div class="table-card-meta">
          <div class="player-count-pill">
            <span class="dot ${countClass}"></span>
            ${t.playerCount} / ${t.maxPlayers} seats
          </div>
        </div>
        <button
          class="btn btn-green w-full"
          ${canJoin ? '' : 'disabled'}
          onclick="window.joinTableById('${t.id}')"
          id="join-btn-${t.id}"
        >
          ${isFull ? 'Table full' : inProgress ? 'Round in progress' : 'Take a seat'}
        </button>
      </div>
    `;
  }).join('');
}

// ── Top-up modal ─────────────────────────────────────────────────

function openTopupModal() {
  const modal = document.getElementById('topup-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeTopupModal() {
  const modal = document.getElementById('topup-modal');
  if (modal) modal.classList.add('hidden');
}

async function doTopup() {
  const confirmBtn = document.getElementById('topup-confirm');
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const freshToken = await getFreshToken();
    const res = await fetch('https://betgame-tsm2.onrender.com/api/player/topup', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token: freshToken }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Top-up failed', 'error');
      return;
    }

    updateHUDCredits(data.credits);
    showToast(`+$100 added! ${data.topupsLeft} top-up${data.topupsLeft !== 1 ? 's' : ''} left today.`, 'gold');
    closeTopupModal();

    // Update game.js state if at a table
    if (typeof window.onCreditsUpdated === 'function') {
      window.onCreditsUpdated(data.credits);
    }

  } catch (e) {
    showToast('Top-up failed. Please try again.', 'error');
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// ── Toast ────────────────────────────────────────────────────────

function showToast(message, type = 'info', durationMs = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.remove(), durationMs);
}

// Export for game.js
window.showToast = showToast;
window.updateHUDCredits = updateHUDCredits;

// ── DOM bindings ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Load profile
  loadPlayerProfile();

  // Top-up buttons
  document.getElementById('topup-btn')?.addEventListener('click', openTopupModal);
  document.getElementById('topup-lobby-btn')?.addEventListener('click', openTopupModal);
  document.getElementById('topup-cancel')?.addEventListener('click', closeTopupModal);
  document.getElementById('topup-confirm')?.addEventListener('click', doTopup);

  // Close modal on backdrop click
  document.getElementById('topup-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('topup-modal')) closeTopupModal();
  });

  // Sign out
  document.getElementById('signout-btn')?.addEventListener('click', () => {
    if (typeof signOut === 'function') signOut();
    else { sessionStorage.clear(); window.location.href = '/'; }
  });
});
