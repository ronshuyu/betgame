'use strict';

// ─── Deck Constants ────────────────────────────────────────────────────────────
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const RANK_VALUES = {
  '2': 2,  '3': 3,  '4': 4,  '5': 5,  '6': 6,  '7': 7,
  '8': 8,  '9': 9, '10': 10,  'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

const SUIT_SYMBOLS = {
  spades:   '♠',
  hearts:   '♥',
  diamonds: '♦',
  clubs:    '♣',
};

const HAND_NAMES = [
  'High Card',       // 0
  'One Pair',        // 1
  'Two Pair',        // 2
  'Three of a Kind', // 3
  'Straight',        // 4
  'Flush',           // 5
  'Full House',      // 6
  'Four of a Kind',  // 7
  'Straight Flush',  // 8
  'Royal Flush',     // 9
];

// ─── Deck Operations ──────────────────────────────────────────────────────────

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, symbol: SUIT_SYMBOLS[suit] });
    }
  }
  return deck; // 52 cards
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Deal N hands of `cardsPerHand` cards each from a freshly shuffled deck.
 * Returns { hands: Card[][], remaining: Card[] }
 */
function dealHands(numPlayers, cardsPerHand = 5) {
  if (numPlayers * cardsPerHand > 52) {
    throw new Error(`Cannot deal ${numPlayers} hands of ${cardsPerHand}: only 52 cards.`);
  }
  const deck = shuffle(createDeck());
  const hands = [];
  for (let i = 0; i < numPlayers; i++) {
    hands.push(deck.splice(0, cardsPerHand));
  }
  return { hands, remaining: deck };
}

// ─── Hand Evaluation ──────────────────────────────────────────────────────────

/**
 * Check if a sorted (desc) array of values forms a straight.
 * Handles the Ace-low straight (A-2-3-4-5).
 */
function checkStraight(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.length < 5) return { isStraight: false };

  // Ace-low check: A-5-4-3-2
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
    return { isStraight: true, highCard: 5 }; // 5-high straight
  }

  for (let i = 0; i < unique.length - 1; i++) {
    if (unique[i] - unique[i + 1] !== 1) return { isStraight: false };
  }
  return { isStraight: true, highCard: unique[0] };
}

/**
 * Build tiebreaker array ordered by group count (desc) then group value (desc).
 * e.g. AAAKK → [14,14,14,13,13], KKKAA → [13,13,13,14,14]
 */
function buildTiebreakers(rankCounts) {
  const groups = Object.entries(rankCounts)
    .map(([rank, count]) => ({ value: RANK_VALUES[rank], count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  return groups.flatMap(({ value, count }) => Array(count).fill(value));
}

/**
 * Evaluate a 5-card poker hand.
 * Returns { rank: number, name: string, tiebreakers: number[] }
 *   rank 0 = High Card … 9 = Royal Flush (higher is better)
 */
function evaluateHand(cards) {
  if (!cards || cards.length !== 5) {
    return { rank: -1, name: 'No Hand', tiebreakers: [] };
  }

  const values   = cards.map(c => RANK_VALUES[c.rank]).sort((a, b) => b - a);
  const suits    = cards.map(c => c.suit);
  const isFlush  = suits.every(s => s === suits[0]);
  const { isStraight, highCard: straightHigh } = checkStraight(values);

  const rankCounts = {};
  cards.forEach(c => { rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1; });
  const counts = Object.values(rankCounts).sort((a, b) => b - a);

  const tiebreakers = buildTiebreakers(rankCounts);
  const straightTiebreakers = isStraight ? [straightHigh] : [];

  // ── Royal Flush ──
  if (isFlush && isStraight && values[0] === 14 && values[4] === 10) {
    return { rank: 9, name: 'Royal Flush', tiebreakers: [14] };
  }
  // ── Straight Flush ──
  if (isFlush && isStraight) {
    return { rank: 8, name: 'Straight Flush', tiebreakers: straightTiebreakers };
  }
  // ── Four of a Kind ──
  if (counts[0] === 4) {
    return { rank: 7, name: 'Four of a Kind', tiebreakers };
  }
  // ── Full House ──
  if (counts[0] === 3 && counts[1] === 2) {
    return { rank: 6, name: 'Full House', tiebreakers };
  }
  // ── Flush ──
  if (isFlush) {
    return { rank: 5, name: 'Flush', tiebreakers: values };
  }
  // ── Straight ──
  if (isStraight) {
    return { rank: 4, name: 'Straight', tiebreakers: straightTiebreakers };
  }
  // ── Three of a Kind ──
  if (counts[0] === 3) {
    return { rank: 3, name: 'Three of a Kind', tiebreakers };
  }
  // ── Two Pair ──
  if (counts[0] === 2 && counts[1] === 2) {
    return { rank: 2, name: 'Two Pair', tiebreakers };
  }
  // ── One Pair ──
  if (counts[0] === 2) {
    return { rank: 1, name: 'One Pair', tiebreakers };
  }
  // ── High Card ──
  return { rank: 0, name: 'High Card', tiebreakers: values };
}

/**
 * Compare multiple player hands and return the uid(s) of the winner(s).
 * Supports split pots (returns array of uids).
 *
 * @param {Array<{uid: string, hand: Card[], evaluation?: object}>} playerHands
 * @returns {string[]} Array of winning uid(s)
 */
function compareHands(playerHands) {
  // Evaluate if not already done
  const evaluated = playerHands.map(ph => ({
    ...ph,
    evaluation: ph.evaluation || evaluateHand(ph.hand),
  }));

  // Find best hand rank
  const bestRank = Math.max(...evaluated.map(ph => ph.evaluation.rank));

  // Filter to players who tied at best rank
  let contenders = evaluated.filter(ph => ph.evaluation.rank === bestRank);

  if (contenders.length === 1) {
    return [contenders[0].uid];
  }

  // Tiebreak using tiebreaker arrays
  const maxLen = Math.max(...contenders.map(ph => ph.evaluation.tiebreakers.length));
  for (let i = 0; i < maxLen; i++) {
    const maxVal = Math.max(...contenders.map(ph => ph.evaluation.tiebreakers[i] ?? 0));
    const stillTied = contenders.filter(ph => (ph.evaluation.tiebreakers[i] ?? 0) === maxVal);
    if (stillTied.length === 1) return [stillTied[0].uid];
    contenders = stillTied;
  }

  // True tie — split pot
  return contenders.map(ph => ph.uid);
}

module.exports = {
  SUITS, RANKS, RANK_VALUES, SUIT_SYMBOLS, HAND_NAMES,
  createDeck, shuffle, dealHands,
  evaluateHand, compareHands,
};
