/**
 * ─── Cryptographic Utilities ─────────────────────────────────────────────────
 *
 * Real wallet generation using ethers.js Wallet.createRandom().
 * Private keys are encrypted with AES-256-GCM before storage.
 *
 * Key derivation:
 *   - 32-byte encryption key = PBKDF2(KEY_ENCRYPTION_SECRET || JWT_SECRET,
 *                                      "dex_wallet_v1", 100_000, sha256)
 *   - Each wallet gets a unique 12-byte IV stored alongside the ciphertext
 *   - Stored format: base64(iv[12] + authTag[16] + ciphertext)
 *
 * **v4 fix for audit #9**: previously the encryption secret was always
 * JWT_SECRET (also used to sign session cookies). Anyone with the
 * session-signing secret could decrypt every wallet key. Now we accept a
 * `secret` parameter at call time, and the live ENV reads
 * KEY_ENCRYPTION_SECRET if set (preferred) and falls back to JWT_SECRET
 * (legacy compat). Operators should set KEY_ENCRYPTION_SECRET to a
 * separate random value in production.
 *
 * NEVER import this file on the client side.
 */
import crypto from "crypto";
import { Wallet, HDNodeWallet, Mnemonic } from "ethers";

// ─── Key Derivation ───────────────────────────────────────────────────────────

const PBKDF2_SALT = "dex_wallet_v1";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = "sha256";

// Per-secret-string cached key — different secrets get different keys
// (callers may pass either KEY_ENCRYPTION_SECRET or JWT_SECRET depending
// on caller-site config; we cache per input string).
const _keyCache = new Map<string, Buffer>();

function getEncryptionKey(secret: string): Buffer {
  const cached = _keyCache.get(secret);
  if (cached) return cached;
  const derived = crypto.pbkdf2Sync(
    secret,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  _keyCache.set(secret, derived);
  return derived;
}

/**
 * Resolves the active key-encryption secret per env. Preferred:
 * KEY_ENCRYPTION_SECRET (separate from session signing).
 *
 * Production: refuses to return without an explicit KEY_ENCRYPTION_SECRET
 * (≥16 chars). Throws — caller is expected to let the process exit on boot.
 * Reusing JWT_SECRET for wallet-key encryption means anyone who can sign
 * sessions can decrypt every wallet, which is the audit-v3 #9 finding.
 *
 * Dev / test: warns once, falls back to JWT_SECRET so local work isn't
 * blocked on the env var.
 */
let _warnedFallback = false;
export function getKeyEncryptionSecret(): string {
  const dedicated = process.env.KEY_ENCRYPTION_SECRET;
  if (dedicated && dedicated.length >= 16) return dedicated;
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    throw new Error(
      "[crypto] KEY_ENCRYPTION_SECRET is required in production (≥16 chars). " +
      "Reusing JWT_SECRET for wallet-key encryption was the audit-v3 #9 vulnerability — refusing to boot.",
    );
  }
  const jwt = process.env.JWT_SECRET ?? "";
  if (!_warnedFallback) {
    console.warn(
      "[crypto] KEY_ENCRYPTION_SECRET not set — falling back to JWT_SECRET (dev/test only). " +
      "Production requires a separate random value.",
    );
    _warnedFallback = true;
  }
  return jwt;
}

// ─── Real Wallet Generation ───────────────────────────────────────────────────

export interface GeneratedWallet {
  address: string;       // 0x-prefixed checksummed address
  encryptedKey: string;  // base64(iv[12] + authTag[16] + ciphertext)
}

/**
 * Generates a real secp256k1 keypair using ethers.js Wallet.createRandom().
 * The private key is immediately encrypted with AES-256-GCM.
 *
 * If `secret` is omitted, uses `getKeyEncryptionSecret()` (preferring
 * KEY_ENCRYPTION_SECRET over JWT_SECRET). Explicit `secret` retained for
 * tests + legacy callers.
 */
export function generateRealWallet(secret?: string): GeneratedWallet {
  const wallet = Wallet.createRandom();
  const address = wallet.address;
  const privateKey = wallet.privateKey;
  const encryptedKey = encryptPrivateKey(privateKey, secret);
  return { address, encryptedKey };
}

/**
 * Deterministic wallet derived from SEED_MNEMONIC at HD path
 * m/44'/60'/0'/0/{index}. Used by the testnet seed so the same 22 shop
 * wallets are produced on every boot — which lets an off-chain funding
 * script (scripts/fund-seed-shops.mjs) pre-fund those exact addresses with
 * Sepolia ETH + vault inventory.
 *
 * If SEED_MNEMONIC is unset, falls back to a random wallet (dev convenience),
 * but those wallets won't be fundable since the script can't derive them.
 */
export function generateDeterministicWallet(index: number, secret?: string): GeneratedWallet {
  const phrase = process.env.SEED_MNEMONIC;
  if (!phrase) {
    console.warn(
      `[crypto] SEED_MNEMONIC not set — seed wallet ${index} is random (NOT fundable). ` +
      `Set SEED_MNEMONIC to make seed shops deterministic + fundable.`,
    );
    return generateRealWallet(secret);
  }
  const mnemonic = Mnemonic.fromPhrase(phrase);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);
  const encryptedKey = encryptPrivateKey(wallet.privateKey, secret);
  return { address: wallet.address, encryptedKey };
}

/**
 * Encrypts a private key string using AES-256-GCM.
 * Returns base64(iv[12] + authTag[16] + ciphertext).
 *
 * `secret` defaults to `getKeyEncryptionSecret()`.
 */
export function encryptPrivateKey(privateKey: string, secret?: string): string {
  const effective = secret ?? getKeyEncryptionSecret();
  const key = getEncryptionKey(effective);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(privateKey, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, ciphertext]);
  return combined.toString("base64");
}

/**
 * Decrypts a private key stored in the format produced by encryptPrivateKey().
 *
 * `secret` defaults to `getKeyEncryptionSecret()`.
 */
export function decryptPrivateKey(encryptedKey: string, secret?: string): string {
  const effective = secret ?? getKeyEncryptionSecret();
  const key = getEncryptionKey(effective);
  const combined = Buffer.from(encryptedKey, "base64");
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// ─── Shared Utilities ─────────────────────────────────────────────────────────

export function isValidEthAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function truncateAddress(address: string, chars = 4): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 2 + chars)}...${address.slice(-chars)}`;
}

// ─── Legacy DEMO stubs (kept for backward compatibility) ─────────────────────

/** @deprecated Use generateRealWallet() instead */
export function demoGenerateAddress(seed: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return "0x" + hash.slice(0, 40);
}

/** @deprecated Use generateRealWallet() instead */
export function demoGeneratePrivateKey(seed: string): string {
  const hash = crypto.createHash("sha512").update(seed + "_pk").digest("hex");
  return "0x" + hash.slice(0, 64);
}

/** @deprecated Use encryptPrivateKey() instead */
export function demoEncryptKey(privateKey: string, secret: string): string {
  const keyBytes = Buffer.from(privateKey.replace("0x", ""), "hex");
  const secretHash = crypto.createHash("sha256").update(secret).digest();
  const encrypted = Buffer.alloc(keyBytes.length);
  for (let i = 0; i < keyBytes.length; i++) {
    encrypted[i] = keyBytes[i]! ^ secretHash[i % secretHash.length]!;
  }
  return encrypted.toString("base64");
}
