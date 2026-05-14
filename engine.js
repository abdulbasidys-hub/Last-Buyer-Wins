'use strict';
require('dotenv').config();

// ─── VALIDATE ENV EARLY ───────────────────────────────────────────────────────
const REQUIRED = ['TOKEN_CA', 'CREATOR_PRIVATE_KEY', 'SOLANATRACKER_API_KEY', 'FIREBASE_SERVICE_ACCOUNT_JSON'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[LBW] ❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}

const cron  = require('node-cron');
const fetch = require('node-fetch'); // must be "node-fetch": "^2.7.0"

const {
  Connection, PublicKey, Transaction,
  SystemProgram, Keypair,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const bs58Raw = require('bs58');
const bs58    = bs58Raw.default ?? bs58Raw;

const { initializeApp, cert }                 = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ─── SOLANA INIT ──────────────────────────────────────────────────────────────
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));
} catch (e) {
  console.error('[LBW] ❌ Bad CREATOR_PRIVATE_KEY:', e.message);
  process.exit(1);
}

// ─── FIREBASE INIT ────────────────────────────────────────────────────────────
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
const TOKEN_CA        = process.env.TOKEN_CA.trim();
const ST_API_KEY      = process.env.SOLANATRACKER_API_KEY.trim();
const CREATOR_ADDR    = (process.env.CREATOR_WALLET || wallet.publicKey.toString()).trim();
const GAS_RESERVE     = parseFloat(process.env.GAS_RESERVE_SOL    || '0.005');
const MIN_DISTRIBUTE  = parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.01');
const TIMER_SECONDS   = parseInt(process.env.TIMER_SECONDS        || '60', 10);
const MIN_BUY_USD     = parseFloat(process.env.MIN_BUY_USD        || '10');
const MIN_POT_SPLIT   = parseFloat(process.env.MIN_POT_FOR_SPLIT  || '1.0'); // SOL — below this leader takes 100%

console.log('╔══════════════════════════════════════════╗');
console.log('║     Last Buyer Wins — Engine Online      ║');
console.log('╚══════════════════════════════════════════╝');
console.log(`[LBW] Token CA      : ${TOKEN_CA}`);
console.log(`[LBW] Payout wallet : ${wallet.publicKey.toString()}`);
console.log(`[LBW] Timer         : ${TIMER_SECONDS}s`);
console.log(`[LBW] Min buy       : $${MIN_BUY_USD} USD`);
console.log(`[LBW] Min payout    : ${MIN_DISTRIBUTE} SOL  Gas reserve: ${GAS_RESERVE} SOL`);
console.log(`[LBW] Min pot split : ${MIN_POT_SPLIT} SOL`);

// ─── IN-MEMORY STATE ──────────────────────────────────────────────────────────
// These reset on redeploy — engine re-seeds them from Firestore on first tick
let lastSeenTxSig = null; // last tx we've already written to Firestore
let lastBuyTimeMs = null; // ms timestamp of the most recent qualifying buy

// ─── UTILITIES ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getBalanceSol() {
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

async function sendSol(toAddress, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey:   new PublicKey(toAddress),
      lamports,
    })
  );
  return sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
}

// ─── SOL PRICE — tries 3 sources in order ────────────────────────────────────
async function fetchSolPriceUsd() {
  const sources = [
    async () => {
      const res  = await fetch('https://price.jup.ag/v4/price?ids=SOL', { timeout: 6000 });
      const data = await res.json();
      return data?.data?.SOL?.price ?? null;
    },
    async () => {
      const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 6000 });
      const data = await res.json();
      return data?.solana?.usd ?? null;
    },
    async () => {
      const res  = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 6000 });
      const data = await res.json();
      return data?.price ? parseFloat(data.price) : null;
    },
  ];
  for (const source of sources) {
    try {
      const price = await source();
      if (price && !isNaN(price) && price > 0) {
        console.log(`[LBW] SOL price: $${parseFloat(price).toFixed(2)}`);
        return parseFloat(price);
      }
    } catch {}
  }
  console.warn('[LBW] Could not fetch SOL price from any source');
  return null;
}

// ─── SOLANATRACKER: fetch recent qualifying buys ──────────────────────────────
// Endpoint: GET https://data.solanatracker.io/trades/{tokenAddress}
// Response: { trades: [{ tx, wallet, type, time(ms), volume(usd), ... }] }
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
    const trades = json.trades ?? json.items ?? (Array.isArray(json) ? json : []);

    console.log(`[LBW] SolanaTracker returned ${trades.length} total trade(s)`);

    return trades
      .filter(t => (t.type || '').toLowerCase() === 'buy')
      .filter(t => {
        const usd = t.volume ?? (t.priceUsd * t.amount) ?? 0;
        if (usd < MIN_BUY_USD) {
          console.log(`[LBW] Skipping buy < $${MIN_BUY_USD} (got $${Number(usd).toFixed(2)}) from ${(t.wallet||'').slice(0,8)}`);
          return false;
        }
        return true;
      })
      .map(t => ({
        wallet:      t.wallet,
        txSignature: t.tx,
        time:        new Date(t.time), // already ms
        volumeUsd:   t.volume ?? null,
      }))
      .filter(t => t.wallet && t.txSignature);

  } catch (e) {
    console.error('[LBW] fetchRecentBuys error:', e.message);
    return [];
  }
}

// ─── TOP-10 HELPERS ───────────────────────────────────────────────────────────

// Takes an array of buy objects (must have .wallet), returns up to 10 unique
// wallet addresses ordered most-recent first. One slot per wallet.
function buildTop10(buys) {
  const seen   = new Set();
  const result = [];
  for (const b of buys) {
    const w = b.wallet;
    if (!w || seen.has(w)) continue;
    seen.add(w);
    result.push(w);
    if (result.length >= 10) break;
  }
  return result; // result[0] = current leader
}

// Given an ordered list of unique wallets and the sendable SOL amount,
// returns { wallet, role, pct, sol } for each.
// Rules:
//   - If pot >= MIN_POT_SPLIT AND 2+ wallets:
//       position 0 (leader) → 50%
//       positions 1-9       → split remaining 50% equally
//   - Otherwise: position 0 takes 100%, rest get 0
function computeShares(wallets, sendableSol) {
  if (wallets.length === 0) return [];

  const useSplit = sendableSol >= MIN_POT_SPLIT && wallets.length > 1;

  return wallets.map((wallet, i) => {
    let pct;
    if (!useSplit) {
      pct = i === 0 ? 1.0 : 0.0;
    } else if (i === 0) {
      pct = 0.5;
    } else {
      pct = 0.5 / (wallets.length - 1);
    }
    return {
      wallet,
      role: i === 0 ? 'leader' : 'pool',
      pct:  parseFloat(pct.toFixed(6)),
      sol:  parseFloat((sendableSol * pct).toFixed(6)),
    };
  });
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────────
async function tick() {
  console.log(`[LBW] ── tick ${new Date().toISOString()} ──`);

  try {

    // ── STEP 1: Seed in-memory state from Firestore if needed ────────────────
    // This runs on first tick after every Railway deploy so the timer is
    // immediately correct without waiting for a new buy to come in.
    if (lastBuyTimeMs === null) {
      try {
        const globalSnap = await db.doc('stats/global').get();
        if (globalSnap.exists) {
          const d = globalSnap.data();
          if (d.lastBuyTime) {
            lastBuyTimeMs = d.lastBuyTime.toMillis();
            console.log(`[LBW] Seeded timer from Firestore: ${new Date(lastBuyTimeMs).toISOString()}`);
          }
          if (d.lastSeenTxSig) {
            lastSeenTxSig = d.lastSeenTxSig;
            console.log(`[LBW] Seeded lastSeenTxSig from Firestore: ${lastSeenTxSig}`);
          }
        }
      } catch (e) {
        console.warn('[LBW] Could not seed from Firestore:', e.message);
      }
      // If still null it's a genuine first run — seed with now
      if (lastBuyTimeMs === null) {
        lastBuyTimeMs = Date.now();
        console.log('[LBW] First run — timer seeded with current time');
      }
    }

    // ── STEP 2: Fetch recent qualifying buys from SolanaTracker ──────────────
    const apiBuys = await fetchRecentBuys();
    console.log(`[LBW] ${apiBuys.length} qualifying buy(s) returned`);

    if (apiBuys.length > 0) {
      // Find buys we haven't written yet by looking for our last seen tx
      const cutoffIdx = lastSeenTxSig
        ? apiBuys.findIndex(b => b.txSignature === lastSeenTxSig)
        : -1;

      // cutoffIdx === -1 means either first run or all buys are new
      // In that case take up to 5 to avoid flooding on first boot
      const newBuys = cutoffIdx === -1
        ? apiBuys.slice(0, 5)
        : apiBuys.slice(0, cutoffIdx);

      if (newBuys.length > 0) {
        console.log(`[LBW] Writing ${newBuys.length} new buy(s) to Firestore`);
        const writeBatch = db.batch();
        for (const b of newBuys) {
          writeBatch.set(
            db.collection('buyers').doc(b.txSignature),
            {
              wallet:      b.wallet,
              txSignature: b.txSignature,
              time:        Timestamp.fromDate(b.time),
              volumeUsd:   b.volumeUsd ?? null,
            },
            { merge: true }
          );
        }
        await writeBatch.commit();
      }

      // Update in-memory state with the freshest buy
      lastSeenTxSig = apiBuys[0].txSignature;
      lastBuyTimeMs = apiBuys[0].time.getTime();
      console.log(`[LBW] Last buyer: ${apiBuys[0].wallet} at ${apiBuys[0].time.toISOString()}`);
    }

    // ── STEP 3: Read all buyers for this round from Firestore ─────────────────
    // Always read from Firestore — survives redeploys, source of truth.
    const buyersSnap  = await db.collection('buyers').orderBy('time', 'desc').limit(100).get();
    const allBuys     = buyersSnap.docs.map(d => d.data());
    const top10       = buildTop10(allBuys);
    console.log(`[LBW] Top ${top10.length} unique wallet(s) in this round`);

    // ── STEP 4: Wallet balance + SOL price ────────────────────────────────────
    const balSol   = await getBalanceSol();
    const sendable = Math.max(0, balSol - GAS_RESERVE);
    const solPrice = await fetchSolPriceUsd();
    const potUsd   = solPrice ? parseFloat((balSol * solPrice).toFixed(2)) : null;

    console.log(`[LBW] Balance: ${balSol.toFixed(4)} SOL | Sendable: ${sendable.toFixed(4)} SOL${potUsd ? ` | ~$${potUsd}` : ''}`);

    // ── STEP 5: Compute live shares for frontend display ──────────────────────
    const sharesLive = computeShares(top10, sendable);

    // ── STEP 6: Write ONE atomic update to stats/global ───────────────────────
    // Timer, pot balance, and top10 shares all land together.
    // Frontend onSnapshot gets one consistent read every time.
    await db.doc('stats/global').set({
      lastBuyTime:   Timestamp.fromDate(new Date(lastBuyTimeMs)),
      lastBuyer:     allBuys[0]?.wallet ?? null,
      lastSeenTxSig: lastSeenTxSig ?? null,
      currentPotSol: parseFloat(balSol.toFixed(4)),
      currentPotUsd: potUsd,
      top10:         sharesLive,
    }, { merge: true });

    // ── STEP 7: Check if timer has expired ────────────────────────────────────
    const elapsedSec = (Date.now() - lastBuyTimeMs) / 1000;
    console.log(`[LBW] Elapsed: ${elapsedSec.toFixed(1)}s / ${TIMER_SECONDS}s`);

    if (elapsedSec < TIMER_SECONDS) {
      console.log(`[LBW] Timer running — ${(TIMER_SECONDS - elapsedSec).toFixed(0)}s left`);
      return; // nothing more to do this tick
    }

    // ── STEP 8: Timer expired — run payout ────────────────────────────────────
    console.log('[LBW] ⏰ Timer expired — running payout');

    if (sendable < MIN_DISTRIBUTE) {
      console.log(`[LBW] Sendable too low (${sendable.toFixed(4)} SOL) — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    if (top10.length === 0) {
      console.log('[LBW] No eligible buyers — resetting timer');
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    // Remove creator wallet from recipients
    const recipients = top10.filter(w => w !== CREATOR_ADDR && w !== wallet.publicKey.toString());
    if (recipients.length === 0) {
      console.log('[LBW] Only creator wallet in top10 — resetting timer');
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    // Compute final payouts
    const payouts = computeShares(recipients, sendable);
    console.log(`[LBW] 🏆 Distributing ${sendable.toFixed(4)} SOL to ${payouts.length} wallet(s):`);
    payouts.forEach((p, i) =>
      console.log(`  [${i === 0 ? 'LEADER' : 'POOL  '}] ${p.wallet} → ${p.sol.toFixed(6)} SOL (${(p.pct * 100).toFixed(1)}%)`)
    );

    // ── STEP 9: Send SOL sequentially ─────────────────────────────────────────
    // Sequential (not parallel) so one failure doesn't affect others.
    // 400ms gap between transactions to avoid RPC rate limits.
    const results = [];
    for (const p of payouts) {
      const lamports = Math.floor(p.sol * LAMPORTS_PER_SOL);
      if (lamports < 5000) {
        console.log(`  [SKIP] ${p.wallet} — amount too small (${lamports} lamports)`);
        continue;
      }
      try {
        const sig = await sendSol(p.wallet, lamports);
        console.log(`  [✅] ${p.wallet} → ${p.sol.toFixed(6)} SOL | TX: ${sig}`);
        results.push({ ...p, txSignature: sig, success: true });
      } catch (e) {
        console.error(`  [❌] ${p.wallet} failed: ${e.message}`);
        results.push({ ...p, success: false });
      }
      await sleep(400);
    }

    const successfulResults = results.filter(r => r.success);
    const totalSentSol      = successfulResults.reduce((sum, r) => sum + r.sol, 0);
    const totalSentUsd      = solPrice ? parseFloat((totalSentSol * solPrice).toFixed(2)) : null;

    // ── STEP 10: Record winners + reset Firestore ─────────────────────────────
    const recordBatch = db.batch();

    for (const r of successfulResults) {
      const wUsd = solPrice ? parseFloat((r.sol * solPrice).toFixed(2)) : null;
      recordBatch.set(db.collection('winners').doc(), {
        wallet:      r.wallet,
        amountSol:   r.sol,
        amountUsd:   wUsd,
        pct:         r.pct,
        role:        r.role,
        txSignature: r.txSignature,
        timestamp:   Timestamp.now(),
      });
    }

    recordBatch.set(db.doc('stats/global'), {
      totalPaidSol:  FieldValue.increment(totalSentSol),
      totalPaidUsd:  FieldValue.increment(totalSentUsd ?? 0),
      totalWinners:  FieldValue.increment(successfulResults.length),
      lastWinner:    recipients[0],
      currentPotSol: 0,
      currentPotUsd: 0,
      lastBuyTime:   Timestamp.now(),
      lastSeenTxSig: null,
      top10:         [],
    }, { merge: true });

    await recordBatch.commit();

    // ── STEP 11: Clear buyers collection — fresh round ────────────────────────
    const clearSnap  = await db.collection('buyers').get();
    if (!clearSnap.empty) {
      const clearBatch = db.batch();
      clearSnap.docs.forEach(d => clearBatch.delete(d.ref));
      await clearBatch.commit();
      console.log(`[LBW] Cleared ${clearSnap.size} buyer doc(s) for new round`);
    }

    // ── STEP 12: Reset in-memory state ────────────────────────────────────────
    lastBuyTimeMs = Date.now();
    lastSeenTxSig = null;

    console.log(`[LBW] 🎉 Round complete — sent ${totalSentSol.toFixed(4)} SOL to ${successfulResults.length} winner(s)`);

  } catch (err) {
    console.error('[LBW] Tick error:', err.message ?? err);
    // Do NOT re-throw — let the cron continue running on next tick
  }
}

// ─── SAFETY NETS ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', r => console.error('[LBW] unhandledRejection:', r));
process.on('uncaughtException',  e => console.error('[LBW] uncaughtException:', e));

// ─── START ────────────────────────────────────────────────────────────────────
tick(); // run immediately on boot
cron.schedule('*/3 * * * * *', tick); // then every 15 seconds
console.log('[LBW] Scheduler started — ticking every 3 seconds');