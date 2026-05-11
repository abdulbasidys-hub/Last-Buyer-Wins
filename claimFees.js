/**
 * claimFees.js — Auto-claim pump.fun creator fees
 * Drop in same folder as engine.js. Call startAutoClaimFees() on boot.
 */

const {
  PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const PUMP_PROGRAM_ID       = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const COLLECT_DISCRIMINATOR = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
const CLAIM_INTERVAL_MS     = 5 * 60 * 1000;  // every 5 minutes
const MIN_CLAIM_LAMPORTS    = 1_000_000;       // skip if under 0.001 SOL (rent dust)

function deriveCreatorVault(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function deriveEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function buildCollectInstruction(creatorPubkey, creatorVaultPDA, eventAuthorityPDA) {
  const keys = [
    { pubkey: creatorPubkey,           isSigner: true,  isWritable: true  },
    { pubkey: creatorVaultPDA,         isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: eventAuthorityPDA,       isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID,         isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data: COLLECT_DISCRIMINATOR,
  });
}

async function claimCreatorFees(connection, creatorKP, log) {
  const creatorPubkey     = creatorKP.publicKey;
  const creatorVaultPDA   = deriveCreatorVault(creatorPubkey);
  const eventAuthorityPDA = deriveEventAuthority();

  let vaultBalance = 0;
  try {
    vaultBalance = await connection.getBalance(creatorVaultPDA);
  } catch { return 0; }

  // Skip if below minimum — avoids claiming rent-exempt dust repeatedly
  if (vaultBalance <= MIN_CLAIM_LAMPORTS) return 0;

  log("  [claim] Vault: " + (vaultBalance/LAMPORTS_PER_SOL).toFixed(6) + " SOL — claiming...");

  try {
    const ix  = buildCollectInstruction(creatorPubkey, creatorVaultPDA, eventAuthorityPDA);
    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(
      connection, tx, [creatorKP], { commitment: "confirmed" }
    );
    const claimed = vaultBalance / LAMPORTS_PER_SOL;
    log("  [claim] Claimed " + claimed.toFixed(6) + " SOL | TX: " + sig);
    return claimed;
  } catch (e) {
    const msg = e.message || "";
    if (!msg.includes("AccountNotFound") && !msg.includes("does not exist")) {
      log("  [claim] Error: " + msg.split("\n")[0]);
    }
    return 0;
  }
}

function startAutoClaimFees(connection, creatorKP, log) {
  const vaultPDA = deriveCreatorVault(creatorKP.publicKey);
  log("[AutoClaim] Vault: " + vaultPDA.toBase58());
  log("[AutoClaim] Every " + (CLAIM_INTERVAL_MS/60000) + " min | Min: " + (MIN_CLAIM_LAMPORTS/LAMPORTS_PER_SOL) + " SOL");

  // Claim on boot
  claimCreatorFees(connection, creatorKP, log).catch(() => {});

  // Then every 5 minutes
  setInterval(() => {
    claimCreatorFees(connection, creatorKP, log).catch(() => {});
  }, CLAIM_INTERVAL_MS);
}

module.exports = { startAutoClaimFees, claimCreatorFees, deriveCreatorVault };