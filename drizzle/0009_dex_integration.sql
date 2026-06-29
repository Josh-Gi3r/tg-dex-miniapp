-- the venue integration columns (Phase 1: Privy auth, Phase 3: API key provisioning,
-- Phase 5: live limit-order linkage on p2pAds)
--
-- All columns nullable so existing rows are unaffected. dexApiSecret stores
-- the AES-256-GCM-encrypted secret returned once by POST /api-keys.

ALTER TABLE `users` ADD COLUMN `privyDid` varchar(80);--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `dexApiKey` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `dexApiSecret` text;--> statement-breakpoint

ALTER TABLE `p2p_ads` ADD COLUMN `settlementOrderId` varchar(66);--> statement-breakpoint
ALTER TABLE `p2p_ads` ADD COLUMN `settlementOrderUuidInt` varchar(80);--> statement-breakpoint
ALTER TABLE `p2p_ads` ADD COLUMN `settlementOrderStatus` enum('pending','matched','settled','cancelled','failed');--> statement-breakpoint

-- Indexes for cancellation lookup + active-ad filtering (Missed-9 in audit)
CREATE INDEX `idx_p2p_ads_settlement_order_id` ON `p2p_ads` (`settlementOrderId`);--> statement-breakpoint
CREATE INDEX `idx_p2p_ads_poster_status` ON `p2p_ads` (`posterId`,`status`);
