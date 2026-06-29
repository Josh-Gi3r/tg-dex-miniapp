CREATE TABLE `p2p_ads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`posterId` int NOT NULL,
	`changerId` int,
	`adType` enum('swap','buy','sell') NOT NULL DEFAULT 'swap',
	`fromToken` varchar(16) NOT NULL,
	`toToken` varchar(16) NOT NULL,
	`rate` decimal(18,8) NOT NULL,
	`liquidity` decimal(18,6) NOT NULL,
	`liquidityRemaining` decimal(18,6) NOT NULL,
	`minOrder` decimal(18,6) NOT NULL DEFAULT '10',
	`maxOrder` decimal(18,6) NOT NULL,
	`terms` text,
	`paymentMethods` text,
	`status` enum('active','paused','cancelled','exhausted') NOT NULL DEFAULT 'active',
	`promotionTier` enum('none','boosted','highlighted','pinned') NOT NULL DEFAULT 'none',
	`promotionExpiresAt` timestamp,
	`totalFills` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`expiresAt` timestamp,
	CONSTRAINT `p2p_ads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `changer_profiles` ADD `completionRate30d` float DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `changer_profiles` ADD `totalOrders30d` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `changer_profiles` ADD `avgSettlementMinutes` float DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `changer_profiles` ADD `telegramHandle` varchar(64);--> statement-breakpoint
ALTER TABLE `changer_profiles` ADD `location` varchar(64);