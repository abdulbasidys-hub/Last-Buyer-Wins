/**
 * Last Buyer Wins — engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs on Railway (Node 18+). Polls every 15 seconds:
 *   1. Fetch recent buys via SolanaTracker
 *   2. Write new buyers to Firestore `buyers/`
 *   3. If 60s pass with no new buy → send SOL to last buyer
 *   4. Record winner in `winners/` and update `stats/global`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * COMMON RAILWAY CRASH CAUSES (all fixed here):
 *   ✅ bs58 v5 uses a default export — accessed as bs58.default.decode()
 *   ✅ node-fetch v2 loaded with require() — v3 is ESM-only, crashes CJS
 *   ✅ FIREBASE_SERVICE_ACCOUNT_JSON parsed safely with try/catch
 *   ✅ Missing env vars caught at startup, not mid-run
 *   ✅ Uncaught promise rejections handled — won't silently kill the process
 */

'use strict';
require('dotenv').config();

// ─── VALIDATE ENV EARLY ───────────────────────────────────────────────────────
const REQUIRED_VARS = [
  'TOKEN_CA',
  'CREATOR_PRIVATE_KEY',
  'SOLANATRACKER_API_KEY',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
];
const missing = REQUIRED_VARS.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[LBW] ❌ Missing required env vars:', missing.join(', '));
  process.exit(1);
}

// ─── IMPORTS ─────────────────────────────────────────────────────────────────
const cron  = require('node-cron');
const fetch = require('node-fetch');   // package.json must pin "node-fetch": "^2.7.0"

const {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

// bs58 v5 ships as ESM with a CJS shim — the decode fn lives on .default
const bs58Raw = require('bs58');
const bs58    = bs58Raw.default ?? bs58Raw;   // works for both v4 and v5

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN_CA       = process.env.TOKEN_CA;
const ST_API_KEY     = process.env.SOLANATRACKER_API_KEY;
const CREATOR_WALLET = process.env.CREATOR_WALLET;        // optional; falls back to key wallet
const GAS_RESERVE    = parseFloat(process.env.GAS_RESERVE_SOL    || '0.005');
const MIN_DISTRIBUTE = parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.01');
const TIMER_SECONDS  = parseInt(process.env.TIMER_SECONDS        || '60', 10);
const SOLANA_RPC     = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

// ─── SOLANA + FIREBASE INIT ───────────────────────────────────────────────────
const connection = new Connection(SOLANA_RPC, 'confirmed');

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));
} catch (e) {
  console.error('[LBW] ❌ Could not decode CREATOR_PRIVATE_KEY — make sure it is base58:', e.message);
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('[LBW] ❌ Could not parse FIREBASE_SERVICE_ACCOUNT_JSON — must be valid JSON on one line:', e.message);
  process.exit(1);
}

try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  console.error('[LBW] ❌ Firebase init failed:', e.message);
  process.exit(1);
}

const db = getFirestore();

const CREATOR_ADDR = CREATOR_WALLET || wallet.publicKey.toString();

console.log('╔══════════════════════════════════════════╗');
console.log('║     Last Buyer Wins — Engine Online      ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`[LBW] Token CA      : ${TOKEN_CA}`);
console.log(`[LBW] Paying wallet : ${wallet.publicKey.toString()}`);
console.log(`[LBW] Timer         : ${TIMER_SECONDS}s`);
console.log(`[LBW] Min distribute: ${MIN_DISTRIBUTE} SOL   Gas reserve: ${GAS_RESERVE} SOL`);
console.log(`[LBW] RPC           : ${SOLANA_RPC}`);

// ─── STATE ────────────────────────────────────────────────────────────────────
let lastSeenTxSig = null;
let lastBuyTimeMs = null;  // ms — updated every time we see a new buy

// ─── UTILS ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getBalanceSol() {
  const lamps = await connection.getBalance(wallet.publicKey);
  return lamps / LAMPORTS_PER_SOL;
}

async function sendSOL(toAddress, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey:   new PublicKey(toAddress),
      lamports,
    })
  );
  return sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
}

// ─── SOL PRICE (Jupiter) ─────────────────────────────────────────────────────
async function fetchSolPriceUsd() {
  try {
    const res  = await fetch('https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112');
    const data = await res.json();
    return data?.data?.So11111111111111111111111111111111111111112?.price ?? null;
  } catch {
    return null;
  }
}

// ─── RECENT BUYERS from SolanaTracker ────────────────────────────────────────
async function fetchRecentBuyers() {
  await sleep(1500); // soft rate-limit guard
  try {
    const url = `https://data.solanatracker.io/tokens/${TOKEN_CA}/trades?limit=25`;
    const res = await fetch(url, {
      headers: { 'x-api-key': ST_API_KEY },
      timeout: 10000,
    });

    if (!res.ok) {
      console.warn(`[LBW] SolanaTracker HTTP ${res.status}`);
      return [];
    }

    const raw = await res.json();

    // SolanaTracker response shape can vary — handle all known shapes
    const trades = Array.isArray(raw)
      ? raw
      : raw.trades ?? raw.items ?? raw.data?.trades ?? raw.data ?? [];

    return trades
      .filter(t => {
        const side = (t.type || t.side || '').toLowerCase();
        return side === 'buy';
      })
      .map(t => ({
        wallet:      t.wallet || t.buyer || t.maker || t.signer || null,
        txSignature: t.signature || t.txSignature || t.tx || t.hash || null,
        time:        t.timestamp
          ? new Date(t.timestamp * 1000)
          : t.blockTime
          ? new Date(t.blockTime * 1000)
          : new Date(),
      }))
      .filter(t => t.wallet && t.txSignature);
  } catch (e) {
    console.error('[LBW] fetchRecentBuyers error:', e.message);
    return [];
  }
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────────
async function tick() {
  const ts = new Date().toISOString();
  console.log(`[LBW] ── ${ts} ──`);

  try {
    // 1. Pull recent buys
    const recentBuys = await fetchRecentBuyers();
    console.log(`[LBW] SolanaTracker returned ${recentBuys.length} buy(s)`);

    if (recentBuys.length > 0) {
      // Find trades we haven't recorded yet
      const cutoffIdx = lastSeenTxSig
        ? recentBuys.findIndex(b => b.txSignature === lastSeenTxSig)
        : -1;

      const newBuys = cutoffIdx === -1
        ? recentBuys.slice(0, 5)   // first run — seed with up to 5 recent
        : recentBuys.slice(0, cutoffIdx);

      if (newBuys.length > 0) {
        console.log(`[LBW] ${newBuys.length} new buy(s) — writing to Firestore`);

        const batch = db.batch();
        for (const buy of newBuys) {
          const ref = db.collection('buyers').doc(buy.txSignature);
          batch.set(ref, {
            wallet:      buy.wallet,
            txSignature: buy.txSignature,
            time:        Timestamp.fromDate(buy.time),
          }, { merge: true });
        }
        await batch.commit();

        // Update in-memory state with newest buy
        lastSeenTxSig = recentBuys[0].txSignature;
        lastBuyTimeMs  = recentBuys[0].time.getTime();

        await db.doc('stats/global').set({
          lastBuyTime: Timestamp.fromDate(recentBuys[0].time),
          lastBuyer:   recentBuys[0].wallet,
        }, { merge: true });

        console.log(`[LBW] Last buyer: ${recentBuys[0].wallet}`);
      } else {
        console.log(`[LBW] No new buys since last tick`);

        // Seed lastBuyTimeMs on first run if we saw existing trades
        if (!lastBuyTimeMs) {
          lastBuyTimeMs  = recentBuys[0].time.getTime();
          lastSeenTxSig  = recentBuys[0].txSignature;
        }
      }
    }

    // 2. Update pot display
    const balSol   = await getBalanceSol();
    const sendable = Math.max(0, balSol - GAS_RESERVE);
    const solPrice = await fetchSolPriceUsd();
    const potUsd   = solPrice ? sendable * solPrice : null;

    await db.doc('stats/global').set({
      currentPotSol: sendable,
      currentPotUsd: potUsd ?? null,
    }, { merge: true });

    console.log(`[LBW] Wallet balance: ${balSol.toFixed(4)} SOL | Sendable: ${sendable.toFixed(4)} SOL${potUsd ? ` (~$${potUsd.toFixed(2)})` : ''}`);

    // 3. Check timer
    if (!lastBuyTimeMs) {
      console.log(`[LBW] No buy history yet — skipping distribution check`);
      return;
    }

    const elapsed = (Date.now() - lastBuyTimeMs) / 1000;
    console.log(`[LBW] Elapsed since last buy: ${elapsed.toFixed(1)}s / ${TIMER_SECONDS}s`);

    if (elapsed < TIMER_SECONDS) {
      console.log(`[LBW] Timer running — ${(TIMER_SECONDS - elapsed).toFixed(0)}s remaining`);
      return;
    }

    // 4. Timer expired — distribute!
    console.log(`[LBW] ⏰ Timer expired! Checking balance...`);

    if (sendable < MIN_DISTRIBUTE) {
      console.log(`[LBW] Balance too low (${sendable.toFixed(4)} SOL < ${MIN_DISTRIBUTE}) — skipping`);
      return;
    }

    // Get last buyer
    const snap = await db.collection('buyers')
      .orderBy('time', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      console.log(`[LBW] No buyers in Firestore — nothing to send`);
      return;
    }

    const lastBuyer = snap.docs[0].data().wallet;

    if (lastBuyer === CREATOR_ADDR || lastBuyer === wallet.publicKey.toString()) {
      console.log(`[LBW] Last buyer is creator wallet — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    // Send it
    const lamports = Math.floor(sendable * LAMPORTS_PER_SOL);
    console.log(`[LBW] 🏆 Sending ${sendable.toFixed(4)} SOL to ${lastBuyer}`);

    let txSig;
    try {
      txSig = await sendSOL(lastBuyer, lamports);
      console.log(`[LBW] ✅ TX confirmed: ${txSig}`);
    } catch (sendErr) {
      console.error(`[LBW] ❌ Send failed:`, sendErr.message);
      // Don't reset timer so we retry next tick if it was transient
      return;
    }

    // 5. Record winner + update stats
    const winSol = sendable;
    const winUsd = solPrice ? winSol * solPrice : null;

    const batch2 = db.batch();
    batch2.set(db.collection('winners').doc(), {
      wallet:      lastBuyer,
      amountSol:   winSol,
      amountUsd:   winUsd ?? null,
      txSignature: txSig,
      timestamp:   Timestamp.now(),
    });
    batch2.set(db.doc('stats/global'), {
      totalPaidSol:  FieldValue.increment(winSol),
      totalPaidUsd:  FieldValue.increment(winUsd ?? 0),
      totalWinners:  FieldValue.increment(1),
      lastWinner:    lastBuyer,
      currentPotSol: 0,
      currentPotUsd: 0,
      lastBuyTime:   Timestamp.now(),  // reset timer
    }, { merge: true });
    await batch2.commit();

    // Reset in-memory timer
    lastBuyTimeMs = Date.now();

    console.log(`[LBW] 🎉 Winner recorded! ${lastBuyer} won ${winSol.toFixed(4)} SOL${winUsd ? ` ($${winUsd.toFixed(2)})` : ''}`);

  } catch (err) {
    console.error('[LBW] Unhandled tick error:', err);
    // Never crash the process — cron will retry on next tick
  }
}

// ─── GLOBAL SAFETY NET ────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[LBW] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[LBW] uncaughtException:', err);
  // Don't exit — keep the engine alive for Railway
});

// ─── START ────────────────────────────────────────────────────────────────────
tick(); // immediate run on boot

// Then every 15 seconds
cron.schedule('*/15 * * * * *', tick);
console.log('[LBW] Scheduler started — ticking every 15 seconds');
