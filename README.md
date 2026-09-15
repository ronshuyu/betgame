# 🃏 BETGAME

A fast-paced, real-time multiplayer card game. Up to 12 players battle across 3 fixed-stake tables using standard poker hand rankings. Built with **Node.js + Socket.io** on the backend and pure **HTML/CSS/JS** on the frontend, with **Google OAuth** and **Firebase Firestore** for persistence.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎯 Multiplayer | Real-time WebSockets, up to 12 players per table |
| 🏆 Poker hands | Royal Flush → High Card on a 52-card deck |
| 💰 Economy | $500 starting credits, top up $100 × 3/day |
| ⚡ Gameplay | Bet, raise, call or fold — 30 s auto-fold timer |
| 🔒 Auth | Google Sign-In via Firebase |
| 🗄️ Persistence | Firebase Firestore (credits, wins, losses) |

---

## 📂 Project Structure

```
betgame/
├── server/
│   ├── index.js          ← Express + Socket.io entry point
│   ├── gameManager.js    ← Table state, phases, turn rotation
│   ├── gameLogic.js      ← Deck, deal, hand evaluation
│   ├── firebaseAdmin.js  ← Firebase Admin + demo fallback
│   └── package.json
│
├── public/               ← Served as static files
│   ├── index.html        ← Login page
│   ├── game.html         ← Lobby + game table
│   ├── css/style.css
│   └── js/
│       ├── auth.js       ← Firebase client auth
│       ├── lobby.js      ← Tables, top-up, HUD
│       └── game.js       ← Socket.io client, card rendering
│
├── .env.example          ← Environment variable template
└── README.md
```

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd server
npm install
```

### 2. Set Up Firebase (required for auth + persistence)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. Enable **Authentication** → **Sign-in methods** → **Google**
3. Enable **Firestore Database** (start in production mode, add rules later)
4. Go to **Project Settings** → **Service accounts** → **Generate new private key** → download JSON
5. Go to **Project Settings** → **Your apps** → Add a **Web app** → copy the config object

### 3. Configure Environment

```bash
# In the server/ directory:
cp ../.env.example .env
```

Edit `.env`:

```env
PORT=3000
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json
```

Place your downloaded service account JSON as `server/serviceAccountKey.json`.

### 4. Configure Client Auth

Open `public/js/auth.js` and replace the placeholder `FIREBASE_CONFIG` with your Firebase web app config:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};
```

### 5. Run the Server

```bash
cd server
npm run dev        # development (auto-reload)
# or
npm start          # production
```

Open **http://localhost:3000** in your browser.

---

## 🎮 How to Play

| Step | Action |
|---|---|
| 1 | Sign in with your Google account |
| 2 | Choose a table: **Low ($5)**, **Mid ($20)**, or **High ($50)** |
| 3 | Click **Ready** when seated |
| 4 | Game starts when all seated players click Ready (min 2) |
| 5 | Cards are dealt — you see your 5 cards face-up |
| 6 | All players ante the base bet |
| 7 | On your turn (30 s timer): **Fold**, **Check/Call**, or **Raise** |
| 8 | One raise allowed per round |
| 9 | Best hand at showdown wins the pot |

---

## 🃏 Hand Rankings (High → Low)

| Rank | Name | Example |
|---|---|---|
| 9 | Royal Flush | A K Q J 10 ♠ |
| 8 | Straight Flush | 9 8 7 6 5 ♥ |
| 7 | Four of a Kind | K K K K 3 |
| 6 | Full House | A A A K K |
| 5 | Flush | A 9 7 4 2 ♦ |
| 4 | Straight | 6 5 4 3 2 |
| 3 | Three of a Kind | Q Q Q 5 2 |
| 2 | Two Pair | J J 8 8 A |
| 1 | One Pair | 10 10 K 7 3 |
| 0 | High Card | A Q 9 6 2 |

---

## 🌐 Running Without Firebase (Demo Mode)

If you don't set up Firebase credentials, the server runs in **demo mode**:
- Player data is stored **in-memory** (resets on server restart)
- Token verification is relaxed (dev only — not secure)
- All game mechanics still work fully

**Demo mode is useful for local testing.** Set up Firebase before any real use.

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: 3000) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | One of two | Path to service account JSON |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | One of two | Service account as JSON string |

---

## 📈 Future Improvements

- [ ] Cashout system for in-game earnings
- [ ] Player emotes and chat
- [ ] Spectator mode
- [ ] Tournament brackets
- [ ] Mobile-first layout

---

## 👨‍💻 Developer

**Amer**  
📧 portgasron22@gmail.com

---

## 📄 License

For educational and personal use only.
