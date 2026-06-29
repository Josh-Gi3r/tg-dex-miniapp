CREATE TABLE `tokenBalances` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`walletAddress` varchar(42) NOT NULL,
	`tokenAddress` varchar(42) NOT NULL,
	`tokenSymbol` varchar(10) NOT NULL,
	`balance` varchar(78) NOT NULL,
	`lastUpdated` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tokenBalances_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`walletAddress` varchar(42) NOT NULL,
	`txHash` varchar(66),
	`fromToken` varchar(42) NOT NULL,
	`toToken` varchar(42) NOT NULL,
	`fromAmount` varchar(78) NOT NULL,
	`toAmount` varchar(78) NOT NULL,
	`exchangeRate` varchar(78) NOT NULL,
	`orderType` enum('limit','market') NOT NULL,
	`status` enum('pending','completed','failed','claiming') NOT NULL DEFAULT 'pending',
	`settlementOrderId` varchar(128),
	`priceIndex` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`telegramId` varchar(64) NOT NULL,
	`walletAddress` varchar(42) NOT NULL,
	`chainId` int NOT NULL DEFAULT 11155111,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wallets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tokenBalances` ADD CONSTRAINT `tokenBalances_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `wallets` ADD CONSTRAINT `wallets_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;