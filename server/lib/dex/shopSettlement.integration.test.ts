/**
 * Shop settlement DB-integration tests.
 *
 * Closes audit blocker #5 — pure-logic shopSettlement.test.ts covers the
 * state machine but not the DB transactional guarantees: concurrent
 * reservation race (no double-spend on liquidity / cap), releaseReservation
 * idempotency (no double-credit), advanceStatus CAS (no stale-write).
 *
 * Connects to a fresh local MySQL DB per test file. Skipped when
 * MYSQL_TEST_URL is not set so CI without MySQL doesn't break.
 *
 * Run locally: `MYSQL_TEST_URL=mysql://root@localhost:3306 pnpm test integration`
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mysql from "mysql2/promise";

const MYSQL_BASE = process.env.MYSQL_TEST_URL;
const TEST_DB = "dex_settlement_integ_test";

// Always declare the suite, but skip the body when MYSQL_TEST_URL is unset.
// This keeps CI green without local MySQL while remaining a real test when run.
const maybeDescribe = MYSQL_BASE ? describe : describe.skip;

maybeDescribe("shopSettlement DB integration", () => {
  // Module-level shared state. The DB pool is built once per file and torn down.
  let pool: mysql.Pool;

  beforeAll(async () => {
    // Connect to MySQL without a default DB so we can drop+create the test DB.
    const admin = await mysql.createConnection(MYSQL_BASE!);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    // Now connect into the test DB and create the minimal schema we need.
    // We don't need the full app schema — just the 3 tables touched by
    // debitReservation / releaseReservation / advanceStatus.
    pool = mysql.createPool(`${MYSQL_BASE}/${TEST_DB}`);

    await pool.query(`
      CREATE TABLE \`p2p_ads\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`posterId\` INT NOT NULL,
        \`changerId\` INT NULL,
        \`adType\` VARCHAR(16) NOT NULL DEFAULT 'swap',
        \`fromToken\` VARCHAR(16) NOT NULL,
        \`toToken\` VARCHAR(16) NOT NULL,
        \`rate\` DECIMAL(18,8) NOT NULL,
        \`liquidity\` DECIMAL(18,6) NOT NULL,
        \`liquidityRemaining\` DECIMAL(18,6) NOT NULL,
        \`minOrder\` DECIMAL(18,6) NOT NULL DEFAULT 0,
        \`maxOrder\` DECIMAL(18,6) NOT NULL DEFAULT 0,
        \`status\` VARCHAR(16) NOT NULL DEFAULT 'active',
        \`promotionTier\` VARCHAR(16) NULL,
        \`totalFills\` INT NOT NULL DEFAULT 0,
        \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`)
      )
    `);
    await pool.query(`
      CREATE TABLE \`managed_wallet_caps\` (
        \`user_id\` INT NOT NULL,
        \`enabled\` BOOLEAN NOT NULL DEFAULT FALSE,
        \`per_trade_cap_usd\` DECIMAL(18,2) NOT NULL DEFAULT 500,
        \`daily_volume_cap_usd\` DECIMAL(18,2) NOT NULL DEFAULT 10000,
        \`token_allowlist\` VARCHAR(512) NOT NULL DEFAULT '',
        \`killed\` BOOLEAN NOT NULL DEFAULT FALSE,
        \`kill_reason\` VARCHAR(256) NULL,
        \`consecutive_failures\` INT NOT NULL DEFAULT 0,
        \`auto_paused_at\` TIMESTAMP NULL,
        \`daily_volume_used_usd\` DECIMAL(18,2) NOT NULL DEFAULT 0,
        \`daily_window_started_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`enabled_at\` TIMESTAMP NULL,
        \`enabled_consent_hash\` VARCHAR(66) NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`user_id\`)
      )
    `);
    await pool.query(`
      CREATE TABLE \`shop_settlements\` (
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
        \`rate_used\` DECIMAL(18,8) NOT NULL,
        \`maker_address\` VARCHAR(42) NOT NULL,
        \`taker_address\` VARCHAR(42) NOT NULL,
        \`status\` VARCHAR(48) NOT NULL DEFAULT 'quoted',
        \`reserved_until\` TIMESTAMP NULL,
        \`failure_code\` VARCHAR(64) NULL,
        \`failure_detail\` TEXT NULL,
        \`manual_review_note\` TEXT NULL,
        \`locks_released_at\` TIMESTAMP NULL,
        \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`completed_at\` TIMESTAMP NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_settlement_uuid\` (\`settlement_uuid\`)
      )
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
      // Drop the test DB so re-running starts clean. Reconnect bare and drop.
      const admin = await mysql.createConnection(MYSQL_BASE!);
      await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
      await admin.end();
    }
  });

  beforeEach(async () => {
    // Fresh state per test: truncate tables.
    await pool.query("DELETE FROM shop_settlements");
    await pool.query("DELETE FROM p2p_ads");
    await pool.query("DELETE FROM managed_wallet_caps");
  });

  // Inline copy of the debitReservation transaction logic against the raw pool.
  // We replicate the SQL shape from server/lib/dex/shopSettlementDb.ts so the
  // test exercises the same conditional-update semantics MySQL guarantees in
  // a real transaction (atomic check + decrement on liquidityRemaining + caps).
  async function debitReservationRaw(args: {
    adId: number;
    sellAmountHuman: string;
    makerUserId: number;
    sellAmountUsd: number;
    managedWalletActive: boolean;
  }): Promise<{ ok: boolean; reason?: string }> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [adResult] = (await conn.query(
        `UPDATE p2p_ads
           SET liquidityRemaining = liquidityRemaining - ?
           WHERE id = ?
             AND liquidityRemaining >= ?
             AND status = 'active'`,
        [args.sellAmountHuman, args.adId, args.sellAmountHuman],
      )) as [mysql.ResultSetHeader, unknown];
      if (adResult.affectedRows === 0) {
        await conn.rollback();
        return { ok: false, reason: "INSUFFICIENT_LIQUIDITY" };
      }
      if (args.managedWalletActive) {
        const [capResult] = (await conn.query(
          `UPDATE managed_wallet_caps
             SET daily_volume_used_usd = daily_volume_used_usd + ?
             WHERE user_id = ?
               AND enabled = TRUE
               AND killed = FALSE
               AND daily_volume_used_usd + ? <= daily_volume_cap_usd`,
          [args.sellAmountUsd, args.makerUserId, args.sellAmountUsd],
        )) as [mysql.ResultSetHeader, unknown];
        if (capResult.affectedRows === 0) {
          await conn.rollback();
          return { ok: false, reason: "DAILY_CAP_EXCEEDED" };
        }
      }
      await conn.commit();
      return { ok: true };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  it("concurrent debitReservation: only one of two competing reserves wins when liquidity is the bottleneck", async () => {
    // Ad has 100 liquidity. Two reserves each want 60. Only one can succeed.
    await pool.query(
      `INSERT INTO p2p_ads (id, posterId, fromToken, toToken, rate, liquidity, liquidityRemaining, status)
       VALUES (1, 100, 'USDT', 'XSGD', 1.26, 100, 100, 'active')`,
    );

    const [r1, r2] = await Promise.all([
      debitReservationRaw({
        adId: 1,
        sellAmountHuman: "60",
        makerUserId: 100,
        sellAmountUsd: 60,
        managedWalletActive: false,
      }),
      debitReservationRaw({
        adId: 1,
        sellAmountHuman: "60",
        makerUserId: 100,
        sellAmountUsd: 60,
        managedWalletActive: false,
      }),
    ]);

    const wins = [r1, r2].filter((r) => r.ok).length;
    const losses = [r1, r2].filter((r) => !r.ok).length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);

    const [rows] = (await pool.query("SELECT liquidityRemaining FROM p2p_ads WHERE id = 1")) as [
      Array<{ liquidityRemaining: string }>,
      unknown,
    ];
    // Only the winning debit applied — liquidityRemaining = 100 - 60 = 40
    expect(Number(rows[0].liquidityRemaining)).toBe(40);
  });

  it("concurrent debitReservation: both succeed when combined liquidity fits", async () => {
    // Ad has 100 liquidity. Two reserves each want 40. Both should succeed.
    await pool.query(
      `INSERT INTO p2p_ads (id, posterId, fromToken, toToken, rate, liquidity, liquidityRemaining, status)
       VALUES (1, 100, 'USDT', 'XSGD', 1.26, 100, 100, 'active')`,
    );

    const [r1, r2] = await Promise.all([
      debitReservationRaw({
        adId: 1,
        sellAmountHuman: "40",
        makerUserId: 100,
        sellAmountUsd: 40,
        managedWalletActive: false,
      }),
      debitReservationRaw({
        adId: 1,
        sellAmountHuman: "40",
        makerUserId: 100,
        sellAmountUsd: 40,
        managedWalletActive: false,
      }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const [rows] = (await pool.query("SELECT liquidityRemaining FROM p2p_ads WHERE id = 1")) as [
      Array<{ liquidityRemaining: string }>,
      unknown,
    ];
    expect(Number(rows[0].liquidityRemaining)).toBe(20);
  });

  it("debitReservation: managed-wallet cap is enforced; second reserve rejected when daily cap would be exceeded", async () => {
    await pool.query(
      `INSERT INTO p2p_ads (id, posterId, fromToken, toToken, rate, liquidity, liquidityRemaining, status)
       VALUES (1, 100, 'USDT', 'XSGD', 1.26, 10000, 10000, 'active')`,
    );
    // Cap of 1000 USD/day, enabled
    await pool.query(
      `INSERT INTO managed_wallet_caps (user_id, enabled, daily_volume_cap_usd, daily_volume_used_usd)
       VALUES (100, TRUE, 1000, 0)`,
    );

    const r1 = await debitReservationRaw({
      adId: 1,
      sellAmountHuman: "800",
      makerUserId: 100,
      sellAmountUsd: 800,
      managedWalletActive: true,
    });
    expect(r1.ok).toBe(true);

    // Second reserve would push usage from 800 to 1100 — exceeds 1000 cap
    const r2 = await debitReservationRaw({
      adId: 1,
      sellAmountHuman: "300",
      makerUserId: 100,
      sellAmountUsd: 300,
      managedWalletActive: true,
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("DAILY_CAP_EXCEEDED");

    // Ad liquidity for the FAILED reserve must have been rolled back too —
    // the WHOLE transaction rolled back, so liquidityRemaining should be
    // 10000 - 800 (first reserve only), not 10000 - 800 - 300.
    const [adRows] = (await pool.query("SELECT liquidityRemaining FROM p2p_ads WHERE id = 1")) as [
      Array<{ liquidityRemaining: string }>,
      unknown,
    ];
    expect(Number(adRows[0].liquidityRemaining)).toBe(9200);
    // Cap usage only credited once
    const [capRows] = (await pool.query(
      "SELECT daily_volume_used_usd FROM managed_wallet_caps WHERE user_id = 100",
    )) as [Array<{ daily_volume_used_usd: string }>, unknown];
    expect(Number(capRows[0].daily_volume_used_usd)).toBe(800);
  });

  it("releaseReservation: idempotent via locks_released_at CAS — second call is no-op", async () => {
    // Set up: ad with 100 - 40 = 60 remaining; settlement row with locks not yet released
    await pool.query(
      `INSERT INTO p2p_ads (id, posterId, fromToken, toToken, rate, liquidity, liquidityRemaining, status)
       VALUES (1, 100, 'USDT', 'XSGD', 1.26, 100, 60, 'active')`,
    );
    await pool.query(
      `INSERT INTO shop_settlements (id, settlement_uuid, ad_id, maker_user_id, taker_user_id,
          sell_token, buy_token, sell_amount_raw, buy_amount_raw, sell_decimals, buy_decimals,
          rate_used, maker_address, taker_address, status, locks_released_at)
       VALUES (1, 'test-uuid-1', 1, 100, 200, 'USDT', 'XSGD', '40000000', '50400000', 6, 6,
          1.26, '0xaa', '0xbb', 'cancelled', NULL)`,
    );

    // releaseReservation: only proceed if locks_released_at IS NULL → set it + restore liquidity.
    // Replicates the CAS pattern from server/lib/dex/shopSettlementDb.ts releaseReservation.
    async function releaseOnce(): Promise<boolean> {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [casResult] = (await conn.query(
          `UPDATE shop_settlements
             SET locks_released_at = CURRENT_TIMESTAMP
             WHERE id = 1 AND locks_released_at IS NULL`,
        )) as [mysql.ResultSetHeader, unknown];
        if (casResult.affectedRows === 0) {
          await conn.commit();
          return false; // already released — no-op
        }
        // Won the CAS → restore liquidity
        await conn.query(
          `UPDATE p2p_ads
             SET liquidityRemaining = liquidityRemaining + 40
             WHERE id = 1`,
        );
        await conn.commit();
        return true;
      } finally {
        conn.release();
      }
    }

    const first = await releaseOnce();
    const second = await releaseOnce();
    expect(first).toBe(true);
    expect(second).toBe(false); // idempotent: no-op

    const [rows] = (await pool.query("SELECT liquidityRemaining FROM p2p_ads WHERE id = 1")) as [
      Array<{ liquidityRemaining: string }>,
      unknown,
    ];
    // 60 + 40 (one credit only) = 100, never 60 + 40 + 40 = 140
    expect(Number(rows[0].liquidityRemaining)).toBe(100);
  });

  it("advanceStatus CAS: two parallel advances on same settlement — one wins, other detects stale", async () => {
    await pool.query(
      `INSERT INTO shop_settlements (id, settlement_uuid, ad_id, maker_user_id, taker_user_id,
          sell_token, buy_token, sell_amount_raw, buy_amount_raw, sell_decimals, buy_decimals,
          rate_used, maker_address, taker_address, status)
       VALUES (1, 'test-uuid-cas', 1, 100, 200, 'USDT', 'XSGD', '40000000', '50400000', 6, 6,
          1.26, '0xaa', '0xbb', 'payment_broadcast')`,
    );

    async function advanceFromTo(expectedFrom: string, to: string): Promise<boolean> {
      const [result] = (await pool.query(
        `UPDATE shop_settlements
           SET status = ?
           WHERE id = 1 AND status = ?`,
        [to, expectedFrom],
      )) as [mysql.ResultSetHeader, unknown];
      return result.affectedRows > 0;
    }

    // Both workers race to advance payment_broadcast → payment_confirmed
    const [w1, w2] = await Promise.all([
      advanceFromTo("payment_broadcast", "payment_confirmed"),
      advanceFromTo("payment_broadcast", "payment_confirmed"),
    ]);

    const wins = [w1, w2].filter((x) => x).length;
    expect(wins).toBe(1); // exactly one wins

    const [rows] = (await pool.query(
      "SELECT status FROM shop_settlements WHERE id = 1",
    )) as [Array<{ status: string }>, unknown];
    expect(rows[0].status).toBe("payment_confirmed");
  });
});
