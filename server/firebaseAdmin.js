'use strict';

const path = require('path');
require('dotenv').config();

let admin = null;
let db = null;
let firebaseEnabled = false;

// In-memory player store for demo mode (no Firebase)
const demoPlayers = {};

// ─── Initialization ────────────────────────────────────────────────────────────

function initFirebase() {
  const hasServicePath = !!process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const hasServiceJson = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!hasServicePath && !hasServiceJson) {
    console.warn('⚠  [Firebase] No credentials found → running in DEMO mode (in-memory, no persistence).');
    return;
  }

  try {
    admin = require('firebase-admin');
    if (admin.apps.length === 0) {
      let serviceAccount;
      if (hasServicePath) {
        serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
      } else {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      }
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    firebaseEnabled = true;
    console.log('✅ [Firebase] Connected to Firestore.');
  } catch (err) {
    console.error('[Firebase] Initialization failed:', err.message);
    console.warn('⚠  [Firebase] Falling back to DEMO mode.');
    firebaseEnabled = false;
  }
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Verify a Firebase ID token.
 * In demo mode, decodes JWT payload (NOT secure — dev only).
 */
async function verifyToken(token) {
  if (!token) throw new Error('No token provided');

  if (firebaseEnabled) {
    return admin.auth().verifyIdToken(token);
  }

  // Demo: trust the base64 payload (development only)
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed token');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      uid: payload.sub || payload.uid || 'demo-user',
      name: payload.name || 'Demo Player',
      picture: payload.picture || '',
      email: payload.email || 'demo@betgame.local',
    };
  } catch {
    throw new Error('Invalid token');
  }
}

// ─── Player CRUD ───────────────────────────────────────────────────────────────

/**
 * Retrieve a player document from Firestore (or demo store).
 * Returns null if not found.
 */
async function getPlayer(uid) {
  if (firebaseEnabled) {
    const doc = await db.collection('players').doc(uid).get();
    return doc.exists ? doc.data() : null;
  }
  return demoPlayers[uid] || null;
}

/**
 * Create a new player profile or return the existing one.
 * New players receive $500 starting credits.
 */
async function createOrUpdatePlayer(uid, displayName, photoURL) {
  const existing = await getPlayer(uid);

  if (existing) {
    // Refresh display info in case it changed
    const updates = { displayName, photoURL, lastSeen: Date.now() };
    if (firebaseEnabled) {
      await db.collection('players').doc(uid).update(updates);
    } else {
      Object.assign(demoPlayers[uid], updates);
    }
    return { ...existing, ...updates };
  }

  const newPlayer = {
    uid,
    displayName,
    photoURL,
    credits: 500,
    wins: 0,
    losses: 0,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    lastTopupDate: null,
    topupCount: 0,
  };

  if (firebaseEnabled) {
    await db.collection('players').doc(uid).set(newPlayer);
  } else {
    demoPlayers[uid] = newPlayer;
  }

  return newPlayer;
}

/**
 * Set an absolute credit value for a player.
 * Also updates top-up tracking fields when called from top-up flow.
 */
async function updateCredits(uid, newCredits, lastTopupDate = null, topupCount = null) {
  const updates = { credits: newCredits, lastSeen: Date.now() };
  if (lastTopupDate !== null) updates.lastTopupDate = lastTopupDate;
  if (topupCount !== null) updates.topupCount = topupCount;

  if (firebaseEnabled) {
    await db.collection('players').doc(uid).update(updates);
  } else if (demoPlayers[uid]) {
    Object.assign(demoPlayers[uid], updates);
  }
}

/** Increment wins counter by 1. */
async function recordWin(uid) {
  if (firebaseEnabled) {
    await db.collection('players').doc(uid).update({
      wins: admin.firestore.FieldValue.increment(1),
      lastSeen: Date.now(),
    });
  } else if (demoPlayers[uid]) {
    demoPlayers[uid].wins = (demoPlayers[uid].wins || 0) + 1;
  }
}

/** Increment losses counter by 1. */
async function recordLoss(uid) {
  if (firebaseEnabled) {
    await db.collection('players').doc(uid).update({
      losses: admin.firestore.FieldValue.increment(1),
      lastSeen: Date.now(),
    });
  } else if (demoPlayers[uid]) {
    demoPlayers[uid].losses = (demoPlayers[uid].losses || 0) + 1;
  }
}

module.exports = {
  initFirebase,
  verifyToken,
  getPlayer,
  createOrUpdatePlayer,
  updateCredits,
  recordWin,
  recordLoss,
  isFirebaseEnabled: () => firebaseEnabled,
};
