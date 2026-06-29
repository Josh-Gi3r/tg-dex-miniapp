CREATE TABLE `badges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`badgeSlug` varchar(64) NOT NULL,
	`earnedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `badges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `changer_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`displayName` varchar(64) NOT NULL,
	`bio` text,
	`avatarUrl` text,
	`isActive` boolean NOT NULL DEFAULT false,
	`reputationScore` float NOT NULL DEFAULT 0,
	`avgRating` float NOT NULL DEFAULT 0,
	`totalRatings` int NOT NULL DEFAULT 0,
	`completionRate` float NOT NULL DEFAULT 100,
	`totalOrdersFilled` int NOT NULL DEFAULT 0,
	`totalVolumeUsd` decimal(18,2) NOT NULL DEFAULT '0',
	`promotionTier` enum('none','boosted','highlighted','pinned') NOT NULL DEFAULT 'none',
	`promotionExpiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `changer_profiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `changer_rates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`changerId` int NOT NULL,
	`fromToken` varchar(16) NOT NULL,
	`toToken` varchar(16) NOT NULL,
	`spreadBps` int NOT NULL DEFAULT 30,
	`minAmount` decimal(18,6) NOT NULL DEFAULT '1',
	`maxAmount` decimal(18,6) NOT NULL DEFAULT '10000',
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `changer_rates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `p2p_orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`changerId` int NOT NULL,
	`takerId` int,
	`fromToken` varchar(16) NOT NULL,
	`toToken` varchar(16) NOT NULL,
	`fromAmount` decimal(18,6) NOT NULL,
	`toAmount` decimal(18,6),
	`rateUsed` decimal(18,8),
	`spreadBps` int,
	`status` enum('pending','filled','cancelled','expired') NOT NULL DEFAULT 'pending',
	`txHash` varchar(66),
	`settlementOrderId` varchar(66),
	`isRatedByTaker` boolean NOT NULL DEFAULT false,
	`isRatedByChanger` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`filledAt` timestamp,
	`expiresAt` timestamp,
	CONSTRAINT `p2p_orders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`changerId` int NOT NULL,
	`tier` enum('boosted','highlighted','pinned') NOT NULL,
	`paidAmountUsdt` decimal(18,6) NOT NULL,
	`startsAt` timestamp NOT NULL DEFAULT (now()),
	`endsAt` timestamp NOT NULL,
	`txHash` varchar(66),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `promotions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ratings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`raterId` int NOT NULL,
	`rateeId` int NOT NULL,
	`orderId` int NOT NULL,
	`score` int NOT NULL,
	`comment` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ratings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `send_claims` (
	`id` int AUTO_INCREMENT NOT NULL,
	`senderId` int NOT NULL,
	`recipientId` int,
	`claimUuid` varchar(36) NOT NULL,
	`fromToken` varchar(16) NOT NULL,
	`toToken` varchar(16) NOT NULL,
	`fromAmount` decimal(18,6) NOT NULL,
	`toAmount` decimal(18,6),
	`estimatedToAmount` decimal(18,6),
	`status` enum('pending','claimed','expired','cancelled') NOT NULL DEFAULT 'pending',
	`txHash` varchar(66),
	`recipientWallet` varchar(42),
	`message` text,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`claimedAt` timestamp,
	CONSTRAINT `send_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `send_claims_claimUuid_unique` UNIQUE(`claimUuid`)
);
--> statement-breakpoint
DROP TABLE `tokenBalances`;--> statement-breakpoint
DROP TABLE `wallets`;--> statement-breakpoint
ALTER TABLE `transactions` DROP FOREIGN KEY `transactions_userId_users_id_fk`;
--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `fromToken` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `toToken` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `fromAmount` decimal(18,6) NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `toAmount` decimal(18,6);--> statement-breakpoint
ALTER TABLE `transactions` MODIFY COLUMN `status` enum('pending','completed','failed') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `transactions` ADD `type` enum('swap','send','receive','fill_order','arb') NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `valueUsd` decimal(18,2);--> statement-breakpoint
ALTER TABLE `transactions` ADD `relatedOrderId` int;--> statement-breakpoint
ALTER TABLE `transactions` ADD `relatedClaimId` int;--> statement-breakpoint
ALTER TABLE `transactions` ADD `xpEarned` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `telegramId` varchar(32);--> statement-breakpoint
ALTER TABLE `users` ADD `telegramUsername` varchar(64);--> statement-breakpoint
ALTER TABLE `users` ADD `walletAddress` varchar(42);--> statement-breakpoint
ALTER TABLE `users` ADD `xp` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `level` enum('novice','trader','dealer','broker','market_maker','legend') DEFAULT 'novice' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totalVolumeUsd` decimal(18,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totalTrades` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `referralCode` varchar(16);--> statement-breakpoint
ALTER TABLE `users` ADD `referredBy` int;--> statement-breakpoint
ALTER TABLE `users` ADD `loginStreak` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `lastLoginDate` timestamp;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `walletAddress`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `exchangeRate`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `orderType`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `settlementOrderId`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `priceIndex`;--> statement-breakpoint
ALTER TABLE `transactions` DROP COLUMN `completedAt`;