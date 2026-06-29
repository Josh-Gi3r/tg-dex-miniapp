CREATE TABLE `quest_completions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`questId` varchar(64) NOT NULL,
	`completedAt` timestamp NOT NULL DEFAULT (now()),
	`xpAwarded` int NOT NULL DEFAULT 0,
	CONSTRAINT `quest_completions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wallet_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`address` varchar(42) NOT NULL,
	`encryptedKey` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `wallet_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallet_keys_userId_unique` UNIQUE(`userId`),
	CONSTRAINT `wallet_keys_address_unique` UNIQUE(`address`)
);
