-- Migration 0007 — Shop settlement state machine
--
-- Adds the tables needed for the coordinated 3-leg shop trade flow
-- specified in SPEC.md §10.2. Replaces the older fiat-escrow path
-- (p2p_orders state machine) for stablecoin-only Shop trades.
--
-- Two tables:
--   shop_settlements      — one row per shop trade, full state machine
--   shop_settlement_legs  — one row per the venue tx leg (audit + tx hash trail)
--   managed_wallet_caps   — per-user managed-shop-wallet limits + status
--
-- Append-only audit: state transitions write a new row to
-- shop_settlement_legs, never mutating prior rows. The current state
-- lives on shop_settlements.status.

CREATE TABLE IF NOT EXISTS `shop_settlements` (
  `id`                       INT NOT NULL AUTO_INCREMENT,
  -- Idempotency: each settlement has a UUID generated at /reserve time.
  -- Re-submitting the same uuid with same parameters returns the same row.
  `settlement_uuid`          VARCHAR(36) NOT NULL,
  `ad_id`                    INT NOT NULL,
  `maker_user_id`            INT NOT NULL,
  `taker_user_id`            INT NOT NULL,
  -- Trade economics
  `sell_token`               VARCHAR(16) NOT NULL,
  `buy_token`                VARCHAR(16) NOT NULL,
  `sell_amount_raw`          VARCHAR(64) NOT NULL,  -- uint256 string
  `buy_amount_raw`           VARCHAR(64) NOT NULL,
  -- Decimals snapshot at reserve time. Workers MUST read from row, never guess.
  -- ARC has 2 decimals (not 6) — guessing 6 mis-credits by 10,000× (audit blocker #2).
  `sell_decimals`            INT NOT NULL,
  `buy_decimals`             INT NOT NULL,
  `rate_used`                DECIMAL(18, 8) NOT NULL,
  -- Wallet addresses (recorded for audit + verification)
  `maker_address`            VARCHAR(42) NOT NULL,
  `taker_address`            VARCHAR(42) NOT NULL,
  -- State machine (mirrors SPEC §10.2)
  `status`                   ENUM(
    'quoted',
    'reserved',
    'payment_pending_signature',
    'payment_broadcast',
    'payment_confirmed',
    'release_pending_signature',
    'release_broadcast',
    'release_confirmed',
    'recycle_pending',
    'completed',
    'expired',
    'cancelled',
    'refund_required',
    'refund_pending',
    'refunded',
    'failed_manual_review'
  ) NOT NULL DEFAULT 'quoted',
  -- TTL for the reservation; if not advanced past `reserved` by then, expire.
  `reserved_until`           TIMESTAMP NULL,
  -- Failure tracking
  `failure_code`             VARCHAR(64) NULL,
  `failure_detail`           TEXT NULL,
  `manual_review_note`       TEXT NULL,
  -- Idempotency guard for releaseReservation — set on first call, prevents
  -- double-credit of liquidity + managed-wallet cap usage. Was added to
  -- schema.ts + bootMigrations.ts TABLE_CHECKS at v4 ship; this line was
  -- missing from the drizzle migration (audit v3 finding — fresh deploys
  -- via `drizzle migrate` would have failed without this).
  `locks_released_at`        TIMESTAMP NULL,
  -- Timing
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at`             TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_settlement_uuid` (`settlement_uuid`),
  KEY `idx_settlement_maker_status` (`maker_user_id`, `status`),
  KEY `idx_settlement_taker_status` (`taker_user_id`, `status`),
  KEY `idx_settlement_status_reserved_until` (`status`, `reserved_until`),
  KEY `idx_settlement_ad` (`ad_id`)
);

CREATE TABLE IF NOT EXISTS `shop_settlement_legs` (
  `id`                       INT NOT NULL AUTO_INCREMENT,
  `settlement_id`            INT NOT NULL,
  -- Leg ordering per SPEC §10.2:
  --   1 = taker → maker wallet (payment)
  --   2 = maker vault → taker wallet (release)
  --   3 = maker wallet → maker vault (recycle)
  --   99 = refund (taker payment returned)
  `leg_number`               TINYINT NOT NULL,
  `leg_kind`                 ENUM('payment', 'release', 'recycle', 'refund') NOT NULL,
  -- the venue API endpoint family this leg invoked
  `settlement_endpoint`            ENUM('transfer', 'withdraw', 'deposit') NOT NULL,
  -- Idempotency: every signed broadcast carries a unique key.
  -- Retries with same key are no-ops (rejects duplicate broadcasts).
  `idempotency_key`          VARCHAR(64) NOT NULL,
  -- Signing party: which wallet authorized this leg
  `signer_address`           VARCHAR(42) NOT NULL,
  `signer_role`              ENUM('taker_privy', 'taker_managed', 'maker_managed') NOT NULL,
  -- Tx state
  `status`                   ENUM('pending_signature', 'broadcast', 'confirmed', 'failed') NOT NULL DEFAULT 'pending_signature',
  `tx_hash`                  VARCHAR(66) NULL,
  `block_number`             BIGINT NULL,
  `gas_used`                 BIGINT NULL,
  `failure_code`             VARCHAR(64) NULL,
  `failure_detail`           TEXT NULL,
  -- Timing
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `broadcast_at`             TIMESTAMP NULL,
  `confirmed_at`             TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_idempotency_key` (`idempotency_key`),
  KEY `idx_leg_settlement` (`settlement_id`, `leg_number`),
  KEY `idx_leg_tx_hash` (`tx_hash`)
);

CREATE TABLE IF NOT EXISTS `managed_wallet_caps` (
  `user_id`                  INT NOT NULL,
  -- Opt-in flag: only true after explicit consent UI
  `enabled`                  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Caps (USD-equivalent). Operator can lower below user-set; user can lower their own.
  `per_trade_cap_usd`        DECIMAL(18, 2) NOT NULL DEFAULT '500',
  `daily_volume_cap_usd`     DECIMAL(18, 2) NOT NULL DEFAULT '10000',
  -- Token allowlist (CSV of symbols, e.g. "USDT,USDC,XSGD"). Empty = no tokens allowed.
  `token_allowlist`          VARCHAR(512) NOT NULL DEFAULT '',
  -- Kill switch — if true, all managed-wallet ops are refused immediately.
  -- Set by user (revoke) or operator (incident response).
  `killed`                   BOOLEAN NOT NULL DEFAULT FALSE,
  `kill_reason`              VARCHAR(256) NULL,
  -- Auto-pause if N consecutive failed settlements
  `consecutive_failures`     INT NOT NULL DEFAULT 0,
  `auto_paused_at`           TIMESTAMP NULL,
  -- Running totals — reset daily by cron
  `daily_volume_used_usd`    DECIMAL(18, 2) NOT NULL DEFAULT '0',
  `daily_window_started_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Consent audit
  `enabled_at`               TIMESTAMP NULL,
  `enabled_consent_hash`     VARCHAR(66) NULL,  -- hash of the consent payload user signed
  -- Lifecycle
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  KEY `idx_managed_enabled` (`enabled`, `killed`)
);
