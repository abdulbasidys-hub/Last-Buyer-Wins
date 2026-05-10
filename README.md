# Last Buyer Wins — $LBW

> The Solana memecoin where the last buyer takes all accumulated dev fees.

---

## Files Overview

```
last-buyer-wins/
├── src/
│   ├── App.jsx        ← Entire frontend UI
│   ├── index.css      ← All styles
│   └── main.jsx       ← React entry point
├── public/
│   └── logo.png       ← Add your token logo here (exact name, lowercase)
├── engine.js          ← Backend distributor (runs on Railway)
├── index.html         ← HTML shell
├── package.json       ← All deps
├── vite.config.js     ← Vite config
├── .env               ← Local env (never commit)
├── engine.env         ← Railway vars reference (never commit)
├── firestore.rules    ← Paste into Firebase Console
└── .gitignore
```

---

## Step-by-Step Setup

### 1. Before You Start
- Have your token CA ready (can be added later)
- Have your creator/dev wallet Phantom private key ready
- Have your Twitter/X handle ready

### 2. Edit App.jsx
Open `src/App.jsx` and update these two lines at the top:
```js
const TOKEN_CA = 'YOUR_TOKEN_CA_HERE';      // paste your contract address
const X_LINK   = 'https://x.com/YOUR_X';   // paste your Twitter URL
```

### 3. Add Your Logo
Drop your token logo into `public/logo.png` (exact filename, lowercase).

### 4. Firebase Setup
1. Go to [firebase.google.com](https://firebase.google.com) → your project
2. Firestore Database → Create database → Production mode
3. **Security Rules** → paste contents of `firestore.rules` → Publish
4. **Project Settings** → Service Accounts → Generate new private key → download JSON
5. Stringify it: `node -e "console.log(JSON.stringify(require('./serviceAccount.json')))"`
6. Copy that single-line output — you'll paste it into Railway

### 5. Deploy Frontend to Vercel
1. Push this project to a GitHub repo
2. [vercel.com](https://vercel.com) → New Project → Import from GitHub
3. Settings → Environment Variables → Add:
   - `VITE_TRACKER_CODE` = `c794133d-56c9-4878-934f-43fb96bdcc2a`
4. Deploy
5. ⚠️ After changing env vars, always manually Redeploy

### 6. Deploy Engine to Railway
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Click your **service card** → Variables tab → add all vars from `engine.env`:
   - `TOKEN_CA`
   - `CREATOR_WALLET`
   - `CREATOR_PRIVATE_KEY`
   - `SOLANATRACKER_API_KEY`
   - `SOLANA_RPC`
   - `MIN_DISTRIBUTE_SOL`
   - `GAS_RESERVE_SOL`
   - `TIMER_SECONDS`
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
3. Settings → Start Command: `node engine.js`
4. Deploy → watch Logs tab

### 7. Verify It's Working
- Railway logs should show `[LBW] Starting Last Buyer Wins engine`
- After any token buy, Firestore `buyers` collection should get a new doc
- After 60s with no buys, the engine sends SOL and writes to `winners`
- The website updates in real time via Firestore onSnapshot listeners

---

## How The Timer Works

```
Someone buys → engine detects it within 15s → records in Firestore buyers/
→ lastBuyTimeMs = now → frontend shows 60s countdown

No one buys for 60s → engine.js tick: elapsedSeconds >= TIMER_SECONDS
→ reads last buyer from Firestore → sends all SOL - gas reserve
→ writes to winners/ → resets timer
```

## Firestore Collections

| Collection | Purpose |
|---|---|
| `buyers/` | Every buy, newest first. `{ wallet, time, txSignature }` |
| `winners/` | Every payout. `{ wallet, amountSol, amountUsd, timestamp, txSignature }` |
| `stats/global` | Single doc with pot, totals, last buy time |

## Customizing the Timer
Change `TIMER_SECONDS` in Railway env vars. Default: 60 (1 minute).

## Troubleshooting

**No buyers showing up?**
- Check Railway logs for `[LBW] Trades fetch error`
- Verify `TOKEN_CA` is correct and has trading activity
- SolanaTracker may have a different response shape — check the raw log

**SOL not being sent?**
- Check `CREATOR_PRIVATE_KEY` is the correct wallet that receives dev fees
- Verify the wallet has SOL above `MIN_DISTRIBUTE_SOL + GAS_RESERVE_SOL`
- Check Railway logs for `[LBW] Send failed`

**Website shows stale data?**
- After Vercel env var changes, manually Redeploy
- Check browser console for Firebase errors

**Railway build hanging?**
- Abort and redeploy — common issue, not a code problem
