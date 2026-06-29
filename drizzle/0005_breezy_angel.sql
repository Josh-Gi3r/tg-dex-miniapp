CREATE TABLE `points_transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`delta` int NOT NULL,
	`reason` enum('referral_signup','referral_trade','trade_completed','quest_completed','milestone_reached','daily_login','admin_grant','spend') NOT NULL,
	`relatedUserId` int,
	`relatedOrderId` int,
	`relatedQuestId` varchar(64),
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `points_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `referrals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referrerId` int NOT NULL,
	`refereeId` int NOT NULL,
	`status` enum('pending','confirmed','rewarded') NOT NULL DEFAULT 'pending',
	`pointsAwarded` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`confirmedAt` timestamp,
	`rewardedAt` timestamp,
	CONSTRAINT `referrals_id` PRIMARY KEY(`id`),
	CONSTRAINT `referrals_refereeId_unique` UNIQUE(`refereeId`)
);
