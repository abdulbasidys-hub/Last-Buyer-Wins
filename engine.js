'use strict';
require('dotenv').config();
const { startAutoClaimFees } = require("./claimFees");

// ─── VALIDATE ENV EARLY ───────────────────────────────────────────────────────
const REQUIRED = ['TOKEN_CA', 'CREATOR_PRIVATE_KEY', 'SOLANATRACKER_API_KEY', 'FIREBASE_SERVICE_ACCOUNT_JSON'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[LBW] ❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}

const cron  = require('node-cron');
const fetch = require('node-fetch');   // must be "node-fetch": "^2.7.0" in package.json

const {
  Connection, PublicKey, Transaction,
  SystemProgram, Keypair,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const bs58Raw = require('bs58');
const bs58    = bs58Raw.default ?? bs58Raw;

const { initializeApp, cert }                  = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp }  = require('firebase-admin/firestore');

// ─── SOLANA ───────────────────────────────────────────────────────────────────
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));
} catch (e) {
  console.error('[LBW] ❌ Bad CREATOR_PRIVATE_KEY:', e.message);
  process.exit(1);
}

// ─── FIREBASE ────────────────────────────────────────────────────────────────
let svcAccount;
try {
  svcAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
  console.error('[LBW] ❌ Bad FIREBASE_SERVICE_ACCOUNT_JSON — must be valid JSON on ONE line:', e.message);
  process.exit(1);
}
try {
  initializeApp({ credential: cert(svcAccount) });
} catch (e) {
  console.error('[LBW] ❌ Firebase init failed:', e.message);
  process.exit(1);
}
const db = getFirestore();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN_CA       = process.env.TOKEN_CA.trim();
const ST_API_KEY     = process.env.SOLANATRACKER_API_KEY.trim();
const CREATOR_ADDR   = (process.env.CREATOR_WALLET || wallet.publicKey.toString()).trim();
const GAS_RESERVE    = parseFloat(process.env.GAS_RESERVE_SOL    || '0.005');
const MIN_DISTRIBUTE = parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.01');
const TIMER_SECONDS  = parseInt(process.env.TIMER_SECONDS        || '60', 10);
const MIN_BUY_USD    = parseFloat(process.env.MIN_BUY_USD        || '10');   // $10 minimum to qualify

console.log('╔══════════════════════════════════════════╗');
console.log('║     Last Buyer Wins — Engine Online      ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`[LBW] Token CA      : ${TOKEN_CA}`);
console.log(`[LBW] Payout wallet : ${wallet.publicKey.toString()}`);
console.log(`[LBW] Timer         : ${TIMER_SECONDS}s`);
console.log(`[LBW] Min buy       : $${MIN_BUY_USD} USD`);
console.log(`[LBW] Min payout    : ${MIN_DISTRIBUTE} SOL  Gas reserve: ${GAS_RESERVE} SOL`);

// ─── STATE ────────────────────────────────────────────────────────────────────
let lastSeenTxSig = null;
let lastBuyTimeMs = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── SOLANA HELPERS ───────────────────────────────────────────────────────────
async function getBalanceSol() {
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

async function sendSol(toAddress, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(toAddress), lamports })
  );
  return sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
}

// ─── SOL/USD PRICE (Jupiter) ─────────────────────────────────────────────────
async function fetchSolPriceUsd() {
  try {
    const res  = await fetch('https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112');
    const data = await res.json();
    return data?.data?.So11111111111111111111111111111111111111112?.price ?? null;
  } catch { return null; }
}

// ─── SOLANATRACKER TRADES ────────────────────────────────────────────────────
// Correct endpoint:  GET https://data.solanatracker.io/trades/{tokenAddress}
// Response shape:    { trades: [ { tx, wallet, type, time, amount, priceUsd, volume, volumeSol, program, pools } ], nextCursor, hasNextPage }
// Key facts:
//   tx        = transaction signature  (NOT "signature")
//   type      = "buy" | "sell"         (NOT "side")
//   time      = Unix ms                (NOT seconds — no *1000 needed)
//   wallet    = buyer/seller wallet
async function fetchRecentBuys() {
  await sleep(1200);
  try {
    const url = `https://data.solanatracker.io/trades/${TOKEN_CA}?sortDirection=DESC&hideArb=true`;
    const res = await fetch(url, {
      headers: { 'x-api-key': ST_API_KEY },
      timeout: 12000,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[LBW] SolanaTracker HTTP ${res.status}: ${body.slice(0, 120)}`);
      return [];
    }

    const json   = await res.json();

    // ── correct shape: { trades: [...] }
    const trades = json.trades ?? json.items ?? (Array.isArray(json) ? json : []);

    console.log(`[LBW] SolanaTracker returned ${trades.length} total trade(s)`);

    if (trades.length > 0) {
      // Log first trade so we can verify shape in Railway logs
      console.log(`[LBW] Sample trade:`, JSON.stringify(trades[0]).slice(0, 200));
    }

    return trades
      .filter(t => (t.type || '').toLowerCase() === 'buy')
      .filter(t => {
        // Enforce minimum buy — SolanaTracker provides `volume` in USD
        const usdValue = t.volume ?? t.priceUsd * t.amount ?? 0;
        if (usdValue < MIN_BUY_USD) {
          // Log rejections so we can verify in Railway logs
          console.log(`[LBW] Skipping buy < $${MIN_BUY_USD} (got $${usdValue?.toFixed(2)}) from ${t.wallet?.slice(0,8)}`);
          return false;
        }
        return true;
      })
      .map(t => ({
        wallet:      t.wallet,
        txSignature: t.tx,              // ← correct field name
        time:        new Date(t.time),  // ← already ms, just wrap in Date
        volumeUsd:   t.volume ?? null,
      }))
      .filter(t => t.wallet && t.txSignature);

  } catch (e) {
    console.error('[LBW] fetchRecentBuys error:', e.message);
    return [];
  }
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────────
async function tick() {
  console.log(`[LBW] ── tick ${new Date().toISOString()} ──`);

  try {
    // 1. Fetch buys
    const buys = await fetchRecentBuys();
    console.log(`[LBW] ${buys.length} buy(s) found after filter`);

    if (buys.length > 0) {
      // Detect new ones (not yet written to Firestore)
      const cutoff  = lastSeenTxSig ? buys.findIndex(b => b.txSignature === lastSeenTxSig) : -1;
      const newBuys = cutoff === -1 ? buys.slice(0, 5) : buys.slice(0, cutoff);

      if (newBuys.length > 0) {
        console.log(`[LBW] Writing ${newBuys.length} new buy(s) to Firestore`);
        const batch = db.batch();
        for (const b of newBuys) {
          batch.set(db.collection('buyers').doc(b.txSignature), {
            wallet:      b.wallet,
            txSignature: b.txSignature,
            time:        Timestamp.fromDate(b.time),
            volumeUsd:   b.volumeUsd ?? null,
          }, { merge: true });
        }
        await batch.commit();
      }

      // Update state with most recent buy
      lastSeenTxSig = buys[0].txSignature;
      lastBuyTimeMs  = buys[0].time.getTime();

      await db.doc('stats/global').set({
        lastBuyTime: Timestamp.fromDate(buys[0].time),
        lastBuyer:   buys[0].wallet,
      }, { merge: true });

      console.log(`[LBW] Last buyer: ${buys[0].wallet} at ${buys[0].time.toISOString()}`);

    } else {
      // No buys returned — still need to write stats/global so the site timer works
      if (!lastBuyTimeMs) {
        await db.doc('stats/global').set({
          lastBuyTime:   Timestamp.now(),
          currentPotSol: 0,
          currentPotUsd: null,
        }, { merge: true });
        lastBuyTimeMs = Date.now();
        console.log(`[LBW] No buys yet — seeded stats/global with current time`);
      } else {
        console.log(`[LBW] No new buys this tick`);
      }
    }

    // 2. Update pot display — merge into same doc in one call
    const balSol    = await getBalanceSol();
    const sendable  = Math.max(0, balSol - GAS_RESERVE);
    const solPrice  = await fetchSolPriceUsd();
    // Use full wallet balance for pot display — picks up manually claimed PumpFun rewards automatically
    const potUsd    = solPrice ? parseFloat((balSol * solPrice).toFixed(2)) : null;

    // Single merged write — frontend snapshot always sees consistent state
    await db.doc('stats/global').set({
      currentPotSol: parseFloat(balSol.toFixed(4)),
      currentPotUsd: potUsd,
    }, { merge: true });

    console.log(`[LBW] Wallet: ${balSol.toFixed(4)} SOL | Sendable: ${sendable.toFixed(4)} SOL${potUsd ? ` | Pot ≈ $${potUsd}` : ''}`);

    // 3. Check timer
    if (!lastBuyTimeMs) return;

    const elapsed = (Date.now() - lastBuyTimeMs) / 1000;
    console.log(`[LBW] Elapsed: ${elapsed.toFixed(1)}s / ${TIMER_SECONDS}s`);

    if (elapsed < TIMER_SECONDS) {
      console.log(`[LBW] Timer running — ${(TIMER_SECONDS - elapsed).toFixed(0)}s left`);
      return;
    }

    // 4. Timer expired — pay out
    console.log(`[LBW] ⏰ Timer expired! Checking for payout...`);

    if (sendable < MIN_DISTRIBUTE) {
      console.log(`[LBW] Balance too low (${sendable.toFixed(4)} SOL) — skipping`);
      return;
    }

    // Get last buyer from Firestore
    const snap = await db.collection('buyers').orderBy('time', 'desc').limit(1).get();
    if (snap.empty) {
      console.log(`[LBW] No buyers in Firestore — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    const lastBuyer = snap.docs[0].data().wallet;
    if (lastBuyer === CREATOR_ADDR || lastBuyer === wallet.publicKey.toString()) {
      console.log(`[LBW] Last buyer is creator — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    // Send SOL
    const lamports = Math.floor(sendable * LAMPORTS_PER_SOL);
    console.log(`[LBW] 🏆 Sending ${sendable.toFixed(4)} SOL to ${lastBuyer}`);

    let txSig;
    try {
      txSig = await sendSol(lastBuyer, lamports);
      console.log(`[LBW] ✅ TX confirmed: ${txSig}`);
    } catch (e) {
      console.error(`[LBW] ❌ Send failed:`, e.message);
      return;
    }

    // Record winner
    const winUsd = solPrice ? parseFloat((sendable * solPrice).toFixed(2)) : null;
    const batch2 = db.batch();
    batch2.set(db.collection('winners').doc(), {
      wallet: lastBuyer, amountSol: sendable, amountUsd: winUsd,
      txSignature: txSig, timestamp: Timestamp.now(),
    });
    batch2.set(db.doc('stats/global'), {
      totalPaidSol:  FieldValue.increment(sendable),
      totalPaidUsd:  FieldValue.increment(winUsd ?? 0),
      totalWinners:  FieldValue.increment(1),
      lastWinner:    lastBuyer,
      currentPotSol: 0,
      currentPotUsd: 0,
      lastBuyTime:   Timestamp.now(),
    }, { merge: true });
    await batch2.commit();

    lastBuyTimeMs = Date.now();
    console.log(`[LBW] 🎉 Winner: ${lastBuyer} won ${sendable.toFixed(4)} SOL${winUsd ? ` ($${winUsd})` : ''}`);

  } catch (err) {
    console.error('[LBW] Tick error:', err.message ?? err);
  }
}

// ─── SAFETY NETS ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', r => console.error('[LBW] unhandledRejection:', r));
process.on('uncaughtException',  e => console.error('[LBW] uncaughtException:', e));

startAutoClaimFees(connection, wallet, console.log)

// ─── START ────────────────────────────────────────────────────────────────────
tick();
cron.schedule('*/3 * * * * *', tick);
console.log('[LBW] Scheduler started — ticking every 3 seconds');
