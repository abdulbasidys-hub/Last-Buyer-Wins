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
  // Try multiple sources in order — Jupiter v6 endpoint changed
  const attempts = [
    // 1. Jupiter price API v2
    async () => {
      const res  = await fetch('https://price.jup.ag/v4/price?ids=SOL', { timeout: 6000 });
      const data = await res.json();
      return data?.data?.SOL?.price ?? null;
    },
    // 2. CoinGecko simple price (no key needed)
    async () => {
      const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 6000 });
      const data = await res.json();
      return data?.solana?.usd ?? null;
    },
    // 3. Binance public ticker
    async () => {
      const res  = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 6000 });
      const data = await res.json();
      return data?.price ? parseFloat(data.price) : null;
    },
  ];

  for (const attempt of attempts) {
    try {
      const price = await attempt();
      if (price && !isNaN(price) && price > 0) {
        console.log(`[LBW] SOL price: $${parseFloat(price).toFixed(2)}`);
        return parseFloat(price);
      }
    } catch {}
  }
  console.warn('[LBW] Could not fetch SOL price from any source');
  return null;
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

// ─── PAYOUT HELPERS ──────────────────────────────────────────────────────────
const MIN_POT_FOR_SPLIT = parseFloat(process.env.MIN_POT_FOR_SPLIT || '1.0'); // SOL

/**
 * Build ordered list of up to 10 unique wallets from recent buys.
 * Most recent buyer first. One slot per wallet — if a wallet bought multiple
 * times, only their most recent buy counts (which is already first in the array).
 */
function buildTop10(buys) {
  const seen = new Set();
  const unique = [];
  for (const b of buys) {
    const w = b.wallet;
    if (!w || seen.has(w)) continue;
    seen.add(w);
    unique.push(w);
    if (unique.length >= 10) break;
  }
  return unique; // unique[0] = leader
}

/**
 * Compute live share display for Firestore (no actual sending).
 * Returns array of { wallet, pct, sol, role } for the frontend to display.
 */
function computeShares(top10, sendableSol) {
  if (top10.length === 0) return [];

  const useSplit = sendableSol >= MIN_POT_FOR_SPLIT && top10.length > 1;

  return top10.map((wallet, i) => {
    let pct;
    if (!useSplit) {
      pct = i === 0 ? 1.0 : 0;
    } else {
      if (i === 0) {
        pct = 0.5; // leader always 50%
      } else {
        const poolMembers = top10.length - 1; // positions 2-10
        pct = 0.5 / poolMembers;
      }
    }
    return {
      wallet,
      pct:  parseFloat(pct.toFixed(6)),
      sol:  parseFloat((sendableSol * pct).toFixed(6)),
      role: i === 0 ? 'leader' : 'pool',
    };
  });
}

/**
 * Compute actual payout amounts.
 * Same logic as computeShares but operates on filtered wallets (creator removed).
 */
function computePayouts(filteredTop10, sendableSol) {
  return computeShares(filteredTop10, sendableSol);
}

// ─── MAIN TICK ───────────────────────────────────────────────────────────────
async function tick() {
  console.log(`[LBW] ── tick ${new Date().toISOString()} ──`);

  try {
    // 1. Fetch buys from SolanaTracker
    const buys = await fetchRecentBuys();
    console.log(`[LBW] ${buys.length} buy(s) found after filter`);

    if (buys.length > 0) {
      // Write any new buys to Firestore buyers collection
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

      // Always update in-memory state from freshest API data
      lastSeenTxSig = buys[0].txSignature;
      lastBuyTimeMs = buys[0].time.getTime();
      console.log(`[LBW] Last buyer: ${buys[0].wallet} at ${buys[0].time.toISOString()}`);

    } else {
      console.log(`[LBW] No new buys this tick`);
    }

    // 2. On boot — if lastBuyTimeMs is still null, seed it from Firestore
    //    so the timer works immediately after a Railway redeploy
    if (!lastBuyTimeMs) {
      const globalDoc = await db.doc('stats/global').get();
      if (globalDoc.exists) {
        const d = globalDoc.data();
        if (d.lastBuyTime) {
          lastBuyTimeMs = d.lastBuyTime.toMillis();
          console.log(`[LBW] Seeded lastBuyTimeMs from Firestore: ${new Date(lastBuyTimeMs).toISOString()}`);
        }
      }
      // If still null (first ever run), seed with now so timer starts
      if (!lastBuyTimeMs) {
        lastBuyTimeMs = Date.now();
        console.log(`[LBW] First run — seeding timer with now`);
      }
    }

    // 3. Read all buyers from Firestore to build top10
    //    (always read from Firestore, not from memory — survives redeploys)
    const allBuysSnap = await db.collection('buyers').orderBy('time', 'desc').limit(100).get();
    const allBuys     = allBuysSnap.docs.map(d => d.data());
    const top10wallets = buildTop10(allBuys);
    console.log(`[LBW] Top ${top10wallets.length} unique wallet(s) this round`);

    // 4. Get wallet balance and SOL price — always, every tick
    const balSol   = await getBalanceSol();
    const sendable = Math.max(0, balSol - GAS_RESERVE);
    const solPrice = await fetchSolPriceUsd();
    const potUsd   = solPrice ? parseFloat((balSol * solPrice).toFixed(2)) : null;

    console.log(`[LBW] Wallet: ${balSol.toFixed(4)} SOL | Sendable: ${sendable.toFixed(4)} SOL${potUsd ? ` | ~$${potUsd}` : ' | SOL price unavailable'}`);

    // 5. Compute live shares for display
    const sharesLive = computeShares(top10wallets, sendable);

    // 6. Write everything to stats/global in ONE call — timer, pot, shares
    const lastBuyTs = new Date(lastBuyTimeMs);
    await db.doc('stats/global').set({
      lastBuyTime:   Timestamp.fromDate(lastBuyTs),
      lastBuyer:     allBuys[0]?.wallet ?? null,
      currentPotSol: parseFloat(balSol.toFixed(4)),
      currentPotUsd: potUsd,
      top10:         sharesLive,
    }, { merge: true });

    // 7. Check timer
    const elapsed = (Date.now() - lastBuyTimeMs) / 1000;
    console.log(`[LBW] Elapsed: ${elapsed.toFixed(1)}s / ${TIMER_SECONDS}s`);

    if (elapsed < TIMER_SECONDS) {
      console.log(`[LBW] Timer running — ${(TIMER_SECONDS - elapsed).toFixed(0)}s left`);
      return;
    }

    // 8. Timer expired — run payout
    console.log(`[LBW] ⏰ Timer expired! Running payout...`);

    if (sendable < MIN_DISTRIBUTE) {
      console.log(`[LBW] Balance too low (${sendable.toFixed(4)} SOL < ${MIN_DISTRIBUTE}) — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    if (top10wallets.length === 0) {
      console.log(`[LBW] No eligible buyers — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    // Filter out creator wallet
    const filtered = top10wallets.filter(w => w !== CREATOR_ADDR && w !== wallet.publicKey.toString());
    if (filtered.length === 0) {
      console.log(`[LBW] All top wallets are creator — resetting timer`);
      lastBuyTimeMs = Date.now();
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
      return;
    }

    // Compute and log payouts
    const payouts = computePayouts(filtered, sendable);
    console.log(`[LBW] 🏆 Distributing ${sendable.toFixed(4)} SOL to ${payouts.length} wallet(s):`);
    payouts.forEach((p,i) => console.log(`  [${i===0?'LEADER':'POOL  '}] ${p.wallet} → ${p.sol.toFixed(6)} SOL (${(p.pct*100).toFixed(1)}%)`));

    // Send sequentially — one failure doesn't block the rest
    const results = [];
    for (const p of payouts) {
      const lamports = Math.floor(p.sol * LAMPORTS_PER_SOL);
      if (lamports < 5000) { console.log(`  [SKIP] ${p.wallet} — dust`); continue; }
      try {
        const sig = await sendSol(p.wallet, lamports);
        console.log(`  [✅] ${p.wallet} → ${p.sol.toFixed(6)} SOL | TX: ${sig}`);
        results.push({ ...p, txSignature: sig, success: true });
        await sleep(400);
      } catch (e) {
        console.error(`  [❌] ${p.wallet} failed:`, e.message);
        results.push({ ...p, success: false });
      }
    }

    const totalSent    = results.filter(r => r.success).reduce((s,r) => s + r.sol, 0);
    const totalSentUsd = solPrice ? parseFloat((totalSent * solPrice).toFixed(2)) : null;

    // Record winners + reset stats
    const batch3 = db.batch();
    for (const r of results.filter(x => x.success)) {
      const wUsd = solPrice ? parseFloat((r.sol * solPrice).toFixed(2)) : null;
      batch3.set(db.collection('winners').doc(), {
        wallet: r.wallet, amountSol: r.sol, amountUsd: wUsd,
        pct: r.pct, role: r.role,
        txSignature: r.txSignature, timestamp: Timestamp.now(),
      });
    }
    batch3.set(db.doc('stats/global'), {
      totalPaidSol:  FieldValue.increment(totalSent),
      totalPaidUsd:  FieldValue.increment(totalSentUsd ?? 0),
      totalWinners:  FieldValue.increment(results.filter(r => r.success).length),
      lastWinner:    filtered[0],
      currentPotSol: 0,
      currentPotUsd: 0,
      lastBuyTime:   Timestamp.now(),
      top10:         [],
    }, { merge: true });
    await batch3.commit();

    // Clear buyers collection for fresh round
    const clearSnap  = await db.collection('buyers').get();
    const clearBatch = db.batch();
    clearSnap.docs.forEach(d => clearBatch.delete(d.ref));
    await clearBatch.commit();

    // Reset in-memory state
    lastBuyTimeMs = Date.now();
    lastSeenTxSig = null;
    console.log(`[LBW] 🎉 Round complete. Sent ${totalSent.toFixed(4)} SOL to ${results.filter(r=>r.success).length} winner(s)`);

  } catch (err) {
    console.error('[LBW] Tick error:', err.message ?? err);
  }
}
// ─── SAFETY NETS ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', r => console.error('[LBW] unhandledRejection:', r));
process.on('uncaughtException',  e => console.error('[LBW] uncaughtException:', e));

// ─── START ────────────────────────────────────────────────────────────────────
tick();
cron.schedule('*/15 * * * * *', tick);
console.log('[LBW] Scheduler started — ticking every 15 seconds');