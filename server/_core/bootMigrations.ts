/**
 * ─── Boot-time schema migrations ────────────────────────────────────────────
 *
 * Drizzle migrations normally run via `pnpm db:push` from the dev's
 * machine. That's fine when there's a developer in the loop, but the
 * production deploy is operated by a non-engineer who doesn't run
 * shell commands. This module fills the gap: every server boot, it
 * runs a short list of idempotent `IF NOT EXISTS`-style checks and
 * applies any missing column. Once applied, the check is a no-op.
 *
 * Add a new entry here when shipping a schema change that needs to
 * land in production without a manual step. Each entry must be
 * idempotent — running twice has the same effect as running once.
 *
 * Detection uses information_schema rather than try/catch on the ALTER
 * itself, so we never silently swallow a real ALTER TABLE error.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";

interface ColumnCheck {
  table: string;
  column: string;
  /** Raw SQL that adds the column. Will only run if the column is absent. */
  addSql: string;
}

const COLUMN_CHECKS: ColumnCheck[] = [
  {
    table: "users",
    column: "pendingQuestXp",
    addSql:
      "ALTER TABLE `users` ADD COLUMN `pendingQuestXp` int NOT NULL DEFAULT 0",
  },
  {
    table: "users",
    column: "testnetFundStatus",
    addSql:
      "ALTER TABLE `users` ADD COLUMN `testnetFundStatus` varchar(160) NULL",
  },
  {
    table: "users",
    column: "onboardingSeen",
    addSql:
      "ALTER TABLE `users` ADD COLUMN `onboardingSeen` text NULL",
  },
  {
    table: "wallet_keys",
    column: "imported",
    addSql:
      "ALTER TABLE `wallet_keys` ADD COLUMN `imported` boolean NOT NULL DEFAULT false",
  },
  // Audit blocker #2 (decimals persistence) — workers must NEVER guess decimals.
  // ARC has 2 decimals; defaulting to 6 mis-credits 10,000×. Existing rows get
  // 6 as a backfill since v1 only used 6-decimal tokens (USDT/USDC/XSGD/etc.).
  {
    table: "shop_settlements",
    column: "sell_decimals",
    addSql:
      "ALTER TABLE `shop_settlements` ADD COLUMN `sell_decimals` INT NOT NULL DEFAULT 6",
  },
  {
    table: "shop_settlements",
    column: "buy_decimals",
    addSql:
      "ALTER TABLE `shop_settlements` ADD COLUMN `buy_decimals` INT NOT NULL DEFAULT 6",
  },
];

/**
 * Table-existence checks (vs ColumnCheck which adds a column).
 * Used for shop settlement v2 which adds 3 brand-new tables.
 */
interface TableCheck {
  table: string;
  /** CREATE TABLE statement — must be idempotent (IF NOT EXISTS). */
  createSql: string;
}

const TABLE_CHECKS: TableCheck[] = [
  {
    table: "shop_settlements",
    createSql: `CREATE TABLE IF NOT EXISTS \`shop_settlements\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`settlement_uuid\` VARCHAR(36) NOT NULL,
      \`ad_id\` INT NOT NULL,
      \`maker_user_id\` INT NOT NULL,
      \`taker_user_id\` INT NOT NULL,
      \`sell_token\` VARCHAR(16) NOT NULL,
      \`buy_token\` VARCHAR(16) NOT NULL,
      \`sell_amount_raw\` VARCHAR(64) NOT NULL,
      \`buy_amount_raw\` VARCHAR(64) NOT NULL,
      \`sell_decimals\` INT NOT NULL,
      \`buy_decimals\` INT NOT NULL,
      \`rate_used\` DECIMAL(18, 8) NOT NULL,
      \`maker_address\` VARCHAR(42) NOT NULL,
      \`taker_address\` VARCHAR(42) NOT NULL,
      \`status\` ENUM(
        'quoted','reserved','payment_pending_signature','payment_broadcast','payment_confirmed',
        'release_pending_signature','release_broadcast','release_confirmed','recycle_pending',
        'completed','expired','cancelled','refund_required','refund_pending','refunded',
        'failed_manual_review'
      ) NOT NULL DEFAULT 'quoted',
      \`reserved_until\` TIMESTAMP NULL,
      \`failure_code\` VARCHAR(64) NULL,
      \`failure_detail\` TEXT NULL,
      \`manual_review_note\` TEXT NULL,
      \`locks_released_at\` TIMESTAMP NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`completed_at\` TIMESTAMP NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_settlement_uuid\` (\`settlement_uuid\`),
      KEY \`idx_settlement_maker_status\` (\`maker_user_id\`, \`status\`),
      KEY \`idx_settlement_taker_status\` (\`taker_user_id\`, \`status\`),
      KEY \`idx_settlement_status_reserved_until\` (\`status\`, \`reserved_until\`),
      KEY \`idx_settlement_ad\` (\`ad_id\`)
    )`,
  },
  {
    table: "shop_settlement_legs",
    createSql: `CREATE TABLE IF NOT EXISTS \`shop_settlement_legs\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`settlement_id\` INT NOT NULL,
      \`leg_number\` TINYINT NOT NULL,
      \`leg_kind\` ENUM('payment','release','recycle','refund') NOT NULL,
      \`settlement_endpoint\` ENUM('transfer','withdraw','deposit') NOT NULL,
      \`idempotency_key\` VARCHAR(64) NOT NULL,
      \`signer_address\` VARCHAR(42) NOT NULL,
      \`signer_role\` ENUM('taker_privy','taker_managed','maker_managed') NOT NULL,
      \`status\` ENUM('pending_signature','broadcast','confirmed','failed') NOT NULL DEFAULT 'pending_signature',
      \`tx_hash\` VARCHAR(66) NULL,
      \`block_number\` BIGINT NULL,
      \`gas_used\` BIGINT NULL,
      \`failure_code\` VARCHAR(64) NULL,
      \`failure_detail\` TEXT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`broadcast_at\` TIMESTAMP NULL,
      \`confirmed_at\` TIMESTAMP NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_idempotency_key\` (\`idempotency_key\`),
      KEY \`idx_leg_settlement\` (\`settlement_id\`, \`leg_number\`),
      KEY \`idx_leg_tx_hash\` (\`tx_hash\`)
    )`,
  },
  {
    table: "managed_wallet_caps",
    createSql: `CREATE TABLE IF NOT EXISTS \`managed_wallet_caps\` (
      \`user_id\` INT NOT NULL,
      \`enabled\` BOOLEAN NOT NULL DEFAULT FALSE,
      \`per_trade_cap_usd\` DECIMAL(18, 2) NOT NULL DEFAULT '500',
      \`daily_volume_cap_usd\` DECIMAL(18, 2) NOT NULL DEFAULT '10000',
      \`token_allowlist\` VARCHAR(512) NOT NULL DEFAULT '',
      \`killed\` BOOLEAN NOT NULL DEFAULT FALSE,
      \`kill_reason\` VARCHAR(256) NULL,
      \`consecutive_failures\` INT NOT NULL DEFAULT 0,
      \`auto_paused_at\` TIMESTAMP NULL,
      \`daily_volume_used_usd\` DECIMAL(18, 2) NOT NULL DEFAULT '0',
      \`daily_window_started_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`enabled_at\` TIMESTAMP NULL,
      \`enabled_consent_hash\` VARCHAR(66) NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`user_id\`),
      KEY \`idx_managed_enabled\` (\`enabled\`, \`killed\`)
    )`,
  },
  {
    table: "rate_history",
    createSql: `CREATE TABLE IF NOT EXISTS \`rate_history\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`fromToken\` VARCHAR(16) NOT NULL,
      \`toToken\` VARCHAR(16) NOT NULL,
      \`settlementRate\` DECIMAL(24, 10) NULL,
      \`oracleMid\` DECIMAL(24, 10) NULL,
      \`edgeBps\` INT NULL,
      \`recordedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_rate_hist_pair_time\` (\`fromToken\`, \`toToken\`, \`recordedAt\`)
    )`,
  },
  {
    table: "agent_trades",
    createSql: `CREATE TABLE IF NOT EXISTS \`agent_trades\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`userId\` INT NOT NULL,
      \`fromToken\` VARCHAR(16) NOT NULL,
      \`toToken\` VARCHAR(16) NOT NULL,
      \`amountIn\` VARCHAR(64) NULL,
      \`minOut\` VARCHAR(80) NULL,
      \`edgeBps\` INT NULL,
      \`settlementTradeId\` VARCHAR(80) NULL,
      \`status\` VARCHAR(48) NULL,
      \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_agent_trades_user\` (\`userId\`, \`createdAt\`)
    )`,
  },
  // Peer (zkP2P) fiat ⇄ crypto ramp — see docs/PEER_INTEGRATION.md.
  {
    table: "peer_intents",
    createSql: `CREATE TABLE IF NOT EXISTS \`peer_intents\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`userId\` INT NOT NULL,
      \`side\` ENUM('onramp','offramp') NOT NULL,
      \`intentHash\` VARCHAR(66) NULL,
      \`depositId\` VARCHAR(80) NULL,
      \`paymentPlatform\` VARCHAR(32) NOT NULL,
      \`fiatCurrency\` VARCHAR(8) NOT NULL,
      \`fiatAmount\` DECIMAL(24, 6) NULL,
      \`usdcAmount\` DECIMAL(24, 6) NULL,
      \`conversionRate\` VARCHAR(40) NULL,
      \`destinationChainId\` INT NULL,
      \`destinationToken\` VARCHAR(80) NULL,
      \`recipientAddress\` VARCHAR(48) NULL,
      \`payeeDetails\` VARCHAR(80) NULL,
      \`status\` VARCHAR(24) NOT NULL DEFAULT 'quoted',
      \`signalTxHash\` VARCHAR(66) NULL,
      \`fulfillTxHash\` VARCHAR(66) NULL,
      \`bridgeTrackingUrl\` VARCHAR(256) NULL,
      \`referrerFeeBps\` INT NULL,
      \`error\` TEXT NULL,
      \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_peer_intents_user\` (\`userId\`, \`createdAt\`),
      KEY \`idx_peer_intents_hash\` (\`intentHash\`)
    )`,
  },
  {
    table: "peer_deposits",
    createSql: `CREATE TABLE IF NOT EXISTS \`peer_deposits\` (
      \`id\` INT NOT NULL AUTO_INCREMENT,
      \`userId\` INT NOT NULL,
      \`depositId\` VARCHAR(80) NULL,
      \`token\` VARCHAR(48) NOT NULL,
      \`amount\` DECIMAL(24, 6) NOT NULL,
      \`minIntent\` DECIMAL(24, 6) NULL,
      \`maxIntent\` DECIMAL(24, 6) NULL,
      \`paymentConfig\` TEXT NULL,
      \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
      \`acceptingIntents\` BOOLEAN NOT NULL DEFAULT TRUE,
      \`createTxHash\` VARCHAR(66) NULL,
      \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_peer_deposits_user\` (\`userId\`, \`createdAt\`)
    )`,
  },
];

export async function runBootMigrations(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[migrate] DB unavailable — skipping boot migrations");
    return;
  }

  for (const check of COLUMN_CHECKS) {
    try {
      const rows = (await db.execute(
        sql.raw(
          `SELECT COUNT(*) AS cnt FROM information_schema.columns
           WHERE table_schema = DATABASE()
           AND table_name = '${check.table}'
           AND column_name = '${check.column}'`,
        ),
      )) as unknown as Array<{ cnt: number | string }>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const present = Number((rows[0] as any)?.cnt ?? 0) > 0;
      if (present) continue;

      console.log(
        `[migrate] adding column ${check.table}.${check.column}…`,
      );
      await db.execute(sql.raw(check.addSql));
      console.log(`[migrate] added ${check.table}.${check.column} ✓`);
    } catch (err) {
      console.error(
        `[migrate] failed to ensure ${check.table}.${check.column}:`,
        err,
      );
      // Deliberately don't throw — a single migration failure shouldn't
      // crash the whole app boot. The affected feature will throw a
      // clearer error at runtime if the column really is missing.
    }
  }

  // Shop settlement tables — idempotent CREATE TABLE IF NOT EXISTS,
  // so safe to call every boot.
  for (const check of TABLE_CHECKS) {
    try {
      await db.execute(sql.raw(check.createSql));
      console.log(`[migrate] ensured table ${check.table} ✓`);
    } catch (err) {
      console.error(`[migrate] failed to ensure table ${check.table}:`, err);
    }
  }
}
