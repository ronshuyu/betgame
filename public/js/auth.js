/* ════════════════════════════════════════════════════════════════
   BETGAME — Client-side Firebase Auth
   ════════════════════════════════════════════════════════════════

   SETUP REQUIRED:
   Replace the placeholder values below with your Firebase project
   config from: Firebase Console → Project Settings → Your apps

   ════════════════════════════════════════════════════════════════ */

// ── Firebase config ──────────────────────────────────────────────
// ⚠  Replace ALL values below with your own Firebase project config
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBTsDw1CEdUungE3gLzqo97XTLZtLzxl4Q",
  authDomain: "betgame-6969.firebaseapp.com",
  projectId: "betgame-6969",
  storageBucket: "betgame-6969.firebasestorage.app",
  messagingSenderId: "32807394192",
  appId: "1:32807394192:web:3c5432b08d66e4e6243115",
  measurementId: "G-G3DZTCK2WH"
};

// ── Initialize Firebase ──────────────────────────────────────────
const firebaseApp  = firebase.initializeApp(FIREBASE_CONFIG);
const firebaseAuth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');

// ── Helpers ──────────────────────────────────────────────────────

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function setLoading(loading) {
  const btn = document.getElementById('google-signin-btn');
  const loader = document.getElementById('login-loading');
  if (btn)    btn.style.display    = loading ? 'none' : '';
  if (loader) loader.classList.toggle('hidden', !loading);
}

// ── Google Sign-In ───────────────────────────────────────────────

async function signInWithGoogle() {
  setLoading(true);
  const errEl = document.getElementById('auth-error');
  if (errEl) errEl.classList.add('hidden');

  try {
    const result = await firebaseAuth.signInWithPopup(googleProvider);
    const token  = await result.user.getIdToken();

    // Sync with backend — creates Firestore profile if first time
    const res = await fetch('https://early-rabbits-report.loca.lt/api/auth/sync', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Bypass-Tunnel-Reminder': 'true'
      },
      body: JSON.stringify({ token }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Sync failed');
    }

    // Store token and uid for socket auth
    sessionStorage.setItem('betgame_token', token);
    sessionStorage.setItem('betgame_uid',   result.user.uid);
    sessionStorage.setItem('betgame_name',  result.user.displayName || 'Player');
    sessionStorage.setItem('betgame_photo', result.user.photoURL    || '');

    // Redirect to lobby
    window.location.href = '/game.html';

  } catch (err) {
    console.error('[Auth]', err);
    setLoading(false);
    if (err.code === 'auth/popup-closed-by-user') {
      showAuthError('Sign-in cancelled. Please try again.');
    } else if (err.code === 'auth/network-request-failed') {
      showAuthError('Network error. Check your connection and try again.');
    } else if (err.message?.includes('YOUR_API_KEY')) {
      showAuthError('⚠ Firebase not configured. Update FIREBASE_CONFIG in public/js/auth.js.');
    } else {
      showAuthError(err.message || 'Sign-in failed. Please try again.');
    }
  }
}

// ── Auth state listener ──────────────────────────────────────────

firebaseAuth.onAuthStateChanged(async (user) => {
  if (!user) return; // not signed in

  // If already signed in and on login page → refresh token and redirect
  if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
    try {
      const token = await user.getIdToken(/* forceRefresh */ true);
      sessionStorage.setItem('betgame_token', token);
      sessionStorage.setItem('betgame_uid',   user.uid);
      sessionStorage.setItem('betgame_name',  user.displayName || 'Player');
      sessionStorage.setItem('betgame_photo', user.photoURL    || '');

      // Re-sync in case credits/profile changed
      await fetch('/api/auth/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      window.location.href = '/game.html';
    } catch (e) {
      // If token refresh fails (e.g. Firebase not configured), stay on page
      console.warn('[Auth] Token refresh failed:', e.message);
    }
  }
});

// ── Token refresh utility (used by lobby/game pages) ─────────────

/**
 * Get a valid (possibly refreshed) Firebase ID token.
 * Returns null if Firebase is not configured or user not signed in.
 */
async function getFreshToken() {
  const user = firebaseAuth.currentUser;
  if (!user) return sessionStorage.getItem('betgame_token');
  try {
    const token = await user.getIdToken(true);
    sessionStorage.setItem('betgame_token', token);
    return token;
  } catch {
    return sessionStorage.getItem('betgame_token');
  }
}

// ── Sign-out ─────────────────────────────────────────────────────

async function signOut() {
  await firebaseAuth.signOut();
  sessionStorage.clear();
  window.location.href = '/';
}

// ── Bind button ──────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('google-signin-btn');
  if (btn) btn.addEventListener('click', signInWithGoogle);
});
