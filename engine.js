/**
 * Last Buyer Wins — engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs on Railway. Every 15 seconds it:
 *   1. Fetches recent buyers from SolanaTracker (token buys)
 *   2. Records every new unique buyer to Firestore `buyers` collection
 *   3. Checks if the last buy was > 60 seconds ago
 *   4. If yes → sends all accumulated dev fees to the last buyer
 *   5. Writes the winner to `winners` collection and updates `stats/global`
 *
 * Firestore collections used:
 *   buyers/   — each doc: { wallet, time (Timestamp), txSignature }
 *   winners/  — each doc: { wallet, amountSol, amountUsd, timestamp, txSignature }
 *   stats/global — { currentPotUsd, currentPotSol, totalPaidUsd, totalPaidSol,
 *                    totalWinners, lastBuyTime (Timestamp), lastWinner }
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const cron  = require('node-cron');
const fetch = require('node-fetch'); // MUST be v2

const {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const bs58 = require('bs58');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// ─── INIT ─────────────────────────────────────────────────────────────────────
const connection = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
const db = getFirestore();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN_CA         = process.env.TOKEN_CA;
const ST_API_KEY       = process.env.SOLANATRACKER_API_KEY;
const CREATOR_WALLET   = process.env.CREATOR_WALLET || wallet.publicKey.toString();
const GAS_RESERVE      = parseFloat(process.env.GAS_RESERVE_SOL  || '0.005');
const MIN_DISTRIBUTE   = parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.01');
const TIMER_SECONDS    = parseInt(process.env.TIMER_SECONDS || '60', 10);

console.log(`[LBW] Starting Last Buyer Wins engine`);
console.log(`[LBW] Token: ${TOKEN_CA}`);
console.log(`[LBW] Creator wallet: ${CREATOR_WALLET}`);
console.log(`[LBW] Timer: ${TIMER_SECONDS}s  |  Min distribute: ${MIN_DISTRIBUTE} SOL  |  Gas reserve: ${GAS_RESERVE} SOL`);

// ─── STATE ────────────────────────────────────────────────────────────────────
let lastSeenTxSig = null;     // track last processed tx to avoid duplicates
let lastBuyTimeMs = null;     // timestamp of the most recent buy we've seen

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWalletBalanceSol() {
  const lamports = await connection.getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
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

// Fetch token price from SolanaTracker
async function fetchTokenPrice() {
  await sleep(1000);
  try {
    const res  = await fetch(`https://data.solanatracker.io/tokens/${TOKEN_CA}`, {
      headers: { 'x-api-key': ST_API_KEY }
    });
    const data = await res.json();
    const p = data?.price?.usd ?? data?.price ?? data?.pools?.[0]?.price?.usd ?? data?.pools?.[0]?.price ?? null;
    return p ? parseFloat(p) : null;
  } catch (e) {
    console.error('[LBW] Price fetch error:', e.message);
    return null;
  }
}

/**
 * Fetch recent buy transactions for the token from SolanaTracker.
 * Returns array of { wallet, txSignature, time } sorted newest first.
 */
async function fetchRecentBuyers() {
  await sleep(2000); // rate-limit guard
  try {
    const res  = await fetch(
      `https://data.solanatracker.io/tokens/${TOKEN_CA}/trades?limit=20`,
      { headers: { 'x-api-key': ST_API_KEY } }
    );
    const raw  = await res.json();

    // SolanaTracker trades endpoint — try known shapes
    const trades = raw.trades ?? raw.items ?? raw.data?.trades ?? (Array.isArray(raw) ? raw : []);

    return trades
      .filter(t => t.type === 'buy' || t.side === 'buy')
      .map(t => ({
        wallet:       t.wallet || t.buyer || t.maker || t.signer || null,
        txSignature:  t.signature || t.txSignature || t.tx || null,
        time:         t.timestamp ? new Date(t.timestamp * 1000) : new Date(t.blockTime * 1000),
      }))
      .filter(t => t.wallet && t.txSignature);
  } catch (e) {
    console.error('[LBW] Trades fetch error:', e.message);
    return [];
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[LBW] ── Tick ${new Date().toISOString()} ──`);

  try {
    // 1. Fetch recent buys
    const recentBuys = await fetchRecentBuyers();

    if (recentBuys.length > 0) {
      // 2. Find new buys we haven't processed yet
      const newBuys = lastSeenTxSig
        ? recentBuys.filter(b => b.txSignature !== lastSeenTxSig).slice(
            0,
            recentBuys.findIndex(b => b.txSignature === lastSeenTxSig)
          )
        : recentBuys.slice(0, 5); // on first run, grab up to 5

      if (newBuys.length > 0) {
        console.log(`[LBW] ${newBuys.length} new buy(s) detected`);

        // Write each new buyer to Firestore
        const batch = db.batch();
        for (const buy of newBuys) {
          batch.set(db.collection('buyers').doc(buy.txSignature), {
            wallet:      buy.wallet,
            txSignature: buy.txSignature,
            time:        Timestamp.fromDate(buy.time),
          });
        }
        await batch.commit();

        // Update last seen
        lastSeenTxSig = recentBuys[0].txSignature;
        lastBuyTimeMs = recentBuys[0].time.getTime();

        // Update stats with last buy time
        await db.doc('stats/global').set({
          lastBuyTime:  Timestamp.fromDate(recentBuys[0].time),
          lastBuyer:    recentBuys[0].wallet,
        }, { merge: true });

        console.log(`[LBW] Last buyer: ${recentBuys[0].wallet} at ${recentBuys[0].time.toISOString()}`);
      } else {
        // No new buys — update lastBuyTimeMs from freshest data if we haven't set it
        if (!lastBuyTimeMs && recentBuys.length > 0) {
          lastBuyTimeMs = recentBuys[0].time.getTime();
          lastSeenTxSig = recentBuys[0].txSignature;
          await db.doc('stats/global').set({
            lastBuyTime: Timestamp.fromDate(recentBuys[0].time),
            lastBuyer:   recentBuys[0].wallet,
          }, { merge: true });
        }
        console.log(`[LBW] No new buys`);
      }
    } else {
      console.log(`[LBW] No trades returned from API`);
    }

    // 3. Check balance and update pot
    const balSol = await getWalletBalanceSol();
    const sendableSol = balSol - GAS_RESERVE;
    const tokenPrice  = await fetchTokenPrice();
    const potUsd = tokenPrice && sendableSol > 0 ? sendableSol * (tokenPrice / 1e9) * 1e9 : null;
    // potUsd approximation: sendableSol * solPrice — but we only have token price
    // For now write raw SOL; USD conversion needs SOL price feed
    // TODO: plug in a SOL/USD feed (e.g. Jupiter price API) for accurate USD display
    const solUsdApprox = await fetchSolPrice();
    const potUsdFinal = solUsdApprox ? sendableSol * solUsdApprox : null;

    await db.doc('stats/global').set({
      currentPotSol: Math.max(0, sendableSol),
      currentPotUsd: potUsdFinal ? Math.max(0, potUsdFinal) : null,
    }, { merge: true });

    // 4. Check timer — should we distribute?
    if (!lastBuyTimeMs) {
      console.log(`[LBW] No buy history yet — skipping distribution check`);
      return;
    }

    const elapsedSeconds = (Date.now() - lastBuyTimeMs) / 1000;
    console.log(`[LBW] Elapsed since last buy: ${elapsedSeconds.toFixed(1)}s / ${TIMER_SECONDS}s`);

    if (elapsedSeconds < TIMER_SECONDS) {
      console.log(`[LBW] Timer still running — no distribution`);
      return;
    }

    // 5. Timer has expired — find last buyer from Firestore
    console.log(`[LBW] ⏰ Timer expired! Checking for winner...`);

    if (sendableSol < MIN_DISTRIBUTE) {
      console.log(`[LBW] Balance too low (${sendableSol.toFixed(4)} SOL) — skipping distribution`);
      return;
    }

    // Get last buyer from Firestore (most recent)
    const buyerSnap = await db.collection('buyers')
      .orderBy('time', 'desc')
      .limit(1)
      .get();

    if (buyerSnap.empty) {
      console.log(`[LBW] No buyers in Firestore — nothing to distribute`);
      return;
    }

    const lastBuyerDoc    = buyerSnap.docs[0].data();
    const lastBuyerWallet = lastBuyerDoc.wallet;

    // Sanity: don't send to the creator wallet itself
    if (lastBuyerWallet === CREATOR_WALLET) {
      console.log(`[LBW] Last buyer is creator wallet — skipping`);
      lastBuyTimeMs = Date.now(); // reset internal timer
      return;
    }

    // 6. Send SOL
    const lamportsToSend = Math.floor(sendableSol * LAMPORTS_PER_SOL);
    console.log(`[LBW] 🏆 Sending ${sendableSol.toFixed(4)} SOL to ${lastBuyerWallet}`);

    let txSig;
    try {
      txSig = await sendSOL(lastBuyerWallet, lamportsToSend);
      console.log(`[LBW] ✅ Sent! TX: ${txSig}`);
    } catch (sendErr) {
      console.error(`[LBW] ❌ Send failed:`, sendErr.message);
      return;
    }

    // 7. Record winner in Firestore
    const winAmountUsd = solUsdApprox ? sendableSol * solUsdApprox : null;
    const batch2 = db.batch();

    batch2.set(db.collection('winners').doc(), {
      wallet:      lastBuyerWallet,
      amountSol:   sendableSol,
      amountUsd:   winAmountUsd,
      txSignature: txSig,
      timestamp:   Timestamp.now(),
    });

    batch2.set(db.doc('stats/global'), {
      totalPaidSol:  FieldValue.increment(sendableSol),
      totalPaidUsd:  winAmountUsd ? FieldValue.increment(winAmountUsd) : FieldValue.increment(0),
      totalWinners:  FieldValue.increment(1),
      lastWinner:    lastBuyerWallet,
      currentPotSol: 0,
      currentPotUsd: 0,
      lastBuyTime:   Timestamp.now(), // reset timer after payout
    }, { merge: true });

    await batch2.commit();
    console.log(`[LBW] 🎉 Winner recorded: ${lastBuyerWallet} won ${sendableSol.toFixed(4)} SOL`);

    // Reset internal timer so we don't re-trigger immediately
    lastBuyTimeMs = Date.now();

  } catch (err) {
    console.error('[LBW] Engine error:', err);
    // Always bump lastBuyTime on error to avoid infinite retry loop
    try {
      await db.doc('stats/global').set({ lastBuyTime: Timestamp.now() }, { merge: true });
    } catch {}
  }
}

// ─── SOL PRICE (Jupiter) ─────────────────────────────────────────────────────
async function fetchSolPrice() {
  try {
    const res  = await fetch('https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112');
    const data = await res.json();
    return data?.data?.So11111111111111111111111111111111111111112?.price ?? null;
  } catch {
    return null;
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
run(); // run immediately on boot

// Then every 15 seconds (checks buys and potentially distributes)
// You can change */15 to */30 or */1 for different check frequencies
// Note: actual payout only happens when timer expires, not every tick
cron.schedule('*/10 * * * * *', run);
