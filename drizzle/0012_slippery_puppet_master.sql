CREATE TABLE `bot_recommendations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('best_rate','stale_offer','wide_spread') NOT NULL,
	`marketSymbol` varchar(32),
	`relatedAdId` int,
	`opportunityScore` float NOT NULL,
	`payload` text NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bot_recommendations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recommendation_outcomes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`recommendationId` int NOT NULL,
	`userId` int NOT NULL,
	`action` enum('delivered','viewed','ignored','acted','resulted_in_trade') NOT NULL,
	`resultTxHash` varchar(66),
	`realizedPnlBps` float,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recommendation_outcomes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recommendation_subscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`enabledTypes` varchar(256) NOT NULL DEFAULT 'best_rate,stale_offer,wide_spread',
	`minScore` float NOT NULL DEFAULT 5,
	`deliveryMethod` enum('telegram','in_app','both') NOT NULL DEFAULT 'both',
	`maxPerHour` int NOT NULL DEFAULT 5,
	`isPaused` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `recommendation_subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `p2p_ads` ADD `settlementOrderId` varchar(66);--> statement-breakpoint
ALTER TABLE `p2p_ads` ADD `settlementOrderUuidInt` varchar(80);--> statement-breakpoint
ALTER TABLE `p2p_ads` ADD `settlementOrderStatus` enum('pending','matched','settled','cancelled','failed');--> statement-breakpoint
ALTER TABLE `p2p_ads` ADD `settlementDepositTxHash` varchar(66);--> statement-breakpoint
ALTER TABLE `users` ADD `privyDid` varchar(80);--> statement-breakpoint
ALTER TABLE `users` ADD `dexApiKey` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `dexApiSecret` text;--> statement-breakpoint
CREATE INDEX `idx_bot_rec_type_expires` ON `bot_recommendations` (`type`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_bot_rec_ad` ON `bot_recommendations` (`relatedAdId`);--> statement-breakpoint
CREATE INDEX `idx_rec_outcome_rec` ON `recommendation_outcomes` (`recommendationId`);--> statement-breakpoint
CREATE INDEX `idx_rec_outcome_user_action` ON `recommendation_outcomes` (`userId`,`action`);--> statement-breakpoint
CREATE INDEX `idx_rec_sub_user` ON `recommendation_subscriptions` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_p2p_ads_settlement_order_id` ON `p2p_ads` (`settlementOrderId`);--> statement-breakpoint
CREATE INDEX `idx_p2p_ads_poster_status` ON `p2p_ads` (`posterId`,`status`);