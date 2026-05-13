/**
 * claimFees.js — Auto-claim creator fees from both pump.fun and PumpSwap
 * ─────────────────────────────────────────────────────────────────────────
 * Handles both phases automatically:
 *   Phase 1 (bonding curve): claims from pump.fun creator vault
 *   Phase 2 (after graduation): claims from PumpSwap creator vault
 *
 * No manual intervention needed at graduation. Both vaults are checked
 * every CLAIM_INTERVAL_MS. Whichever has a balance gets claimed.
 */

const {
  PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

// ── Program IDs ───────────────────────────────────────────────────────────────
const PUMP_PROGRAM_ID    = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM_ID= new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

// ── Anchor discriminators ─────────────────────────────────────────────────────
// sha256("global:collect_creator_fee")[0..8]
const PUMP_COLLECT_DISCRIMINATOR     = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
// sha256("global:collect_coin_creator_fee")[0..8]
const PUMPSWAP_COLLECT_DISCRIMINATOR = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);

// ── Config ────────────────────────────────────────────────────────────────────
const CLAIM_INTERVAL_MS  = 30 * 1000;   // claim every 30 seconds
const MIN_CLAIM_LAMPORTS = 1_000_000;   // skip if under 0.001 SOL (rent dust)

// ── PDA derivations ───────────────────────────────────────────────────────────

// pump.fun creator vault: ["creator-vault", creator_pubkey]
function derivePumpVault(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// pump.fun event authority: ["__event_authority"]
function derivePumpEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// PumpSwap creator vault authority: ["creator_vault", creator_pubkey]
function derivePumpSwapVaultAuthority(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), creatorPubkey.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  );
  return pda;
}

// PumpSwap event authority: ["__event_authority"]
function derivePumpSwapEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMPSWAP_PROGRAM_ID
  );
  return pda;
}

// ── Phase 1: pump.fun bonding curve fee claim ─────────────────────────────────
async function claimPumpFees(connection, creatorKP, log) {
  const creatorPubkey     = creatorKP.publicKey;
  const vaultPDA          = derivePumpVault(creatorPubkey);
  const eventAuthorityPDA = derivePumpEventAuthority();

  let balance = 0;
  try { balance = await connection.getBalance(vaultPDA); } catch { return 0; }
  if (balance <= MIN_CLAIM_LAMPORTS) return 0;

  log("  [pump.fun] Vault: " + (balance/LAMPORTS_PER_SOL).toFixed(6) + " SOL — claiming...");

  try {
    const ix = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      data: PUMP_COLLECT_DISCRIMINATOR,
      keys: [
        { pubkey: creatorPubkey,           isSigner: true,  isWritable: true  },
        { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPDA,       isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID,         isSigner: false, isWritable: false },
      ],
    });

    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(
      connection, tx, [creatorKP], { commitment: "confirmed" }
    );
    const claimed = balance / LAMPORTS_PER_SOL;
    log("  [pump.fun] Claimed " + claimed.toFixed(6) + " SOL | TX: " + sig);
    return claimed;

  } catch (e) {
    const msg = e.message || "";
    // Vault not initialized yet — normal before first trade
    if (msg.includes("AccountNotFound") || msg.includes("does not exist")) return 0;
    log("  [pump.fun] Error: " + msg.split("\n")[0]);
    return 0;
  }
}

// ── Phase 2: PumpSwap (post-graduation) fee claim ────────────────────────────
// After graduation, fees accumulate in a WSOL ATA owned by the vault authority.
// The collect_coin_creator_fee instruction unwraps WSOL → SOL into creator wallet.
async function claimPumpSwapFees(connection, creatorKP, log) {
  const creatorPubkey        = creatorKP.publicKey;
  const vaultAuthority       = derivePumpSwapVaultAuthority(creatorPubkey);
  const eventAuthorityPDA    = derivePumpSwapEventAuthority();

  // The vault authority's native SOL balance tells us if there's anything to claim
  let balance = 0;
  try { balance = await connection.getBalance(vaultAuthority); } catch { return 0; }

  // PumpSwap keeps rent in the authority — only claim if meaningfully above rent
  if (balance <= 2_000_000) return 0; // 0.002 SOL threshold for PumpSwap

  log("  [pumpswap] Vault authority: " + (balance/LAMPORTS_PER_SOL).toFixed(6) + " SOL — claiming...");

  try {
    // PumpSwap collect_coin_creator_fee accounts:
    // creator, vault_authority, system_program, event_authority, program
    const ix = new TransactionInstruction({
      programId: PUMPSWAP_PROGRAM_ID,
      data: PUMPSWAP_COLLECT_DISCRIMINATOR,
      keys: [
        { pubkey: creatorPubkey,           isSigner: true,  isWritable: true  },
        { pubkey: vaultAuthority,          isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPDA,       isSigner: false, isWritable: false },
        { pubkey: PUMPSWAP_PROGRAM_ID,     isSigner: false, isWritable: false },
      ],
    });

    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(
      connection, tx, [creatorKP], { commitment: "confirmed" }
    );
    const claimed = balance / LAMPORTS_PER_SOL;
    log("  [pumpswap] Claimed " + claimed.toFixed(6) + " SOL | TX: " + sig);
    return claimed;

  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("AccountNotFound") || msg.includes("does not exist")) return 0;
    // PumpSwap vault not initialized yet — normal before graduation
    if (msg.includes("custom program error") || msg.includes("0x")) return 0;
    log("  [pumpswap] Error: " + msg.split("\n")[0]);
    return 0;
  }
}

// ── Main claim — tries both, logs which phase is active ──────────────────────
async function claimAllFees(connection, creatorKP, log) {
  const pumpClaimed     = await claimPumpFees(connection, creatorKP, log);
  const pumpSwapClaimed = await claimPumpSwapFees(connection, creatorKP, log);
  const total = pumpClaimed + pumpSwapClaimed;
  if (total > 0) {
    log("  [claim] Total claimed: " + total.toFixed(6) + " SOL");
  }
  return total;
}

// ── Start auto-claim loop ─────────────────────────────────────────────────────
function startAutoClaimFees(connection, creatorKP, log) {
  const pumpVault    = derivePumpVault(creatorKP.publicKey);
  const swapAuthority= derivePumpSwapVaultAuthority(creatorKP.publicKey);

  log("[AutoClaim] pump.fun vault  : " + pumpVault.toBase58());
  log("[AutoClaim] PumpSwap vault  : " + swapAuthority.toBase58());
  log("[AutoClaim] Interval        : " + (CLAIM_INTERVAL_MS/1000) + "s");
  log("[AutoClaim] Min threshold   : " + (MIN_CLAIM_LAMPORTS/LAMPORTS_PER_SOL) + " SOL");

  // Claim immediately on boot
  claimAllFees(connection, creatorKP, log).catch(() => {});

  // Then on interval
  setInterval(() => {
    claimAllFees(connection, creatorKP, log).catch(() => {});
  }, CLAIM_INTERVAL_MS);
}

module.exports = {
  startAutoClaimFees,
  claimAllFees,
  claimPumpFees,
  claimPumpSwapFees,
  derivePumpVault,
  derivePumpSwapVaultAuthority,
};