CREATE TABLE `yield_cycles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`totalAssets` decimal(30,6) NOT NULL,
	`totalShares` decimal(30,12) NOT NULL,
	`pnlBps` float NOT NULL,
	`feeBps` float NOT NULL DEFAULT 0,
	`status` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `yield_cycles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `yield_fills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cycleId` int NOT NULL,
	`settlementTradeId` varchar(66) NOT NULL,
	`txHash` varchar(66) NOT NULL,
	`pair` varchar(32) NOT NULL,
	`side` enum('buy','sell') NOT NULL,
	`amountBase` decimal(30,6) NOT NULL,
	`amountQuote` decimal(30,6) NOT NULL,
	`realizedSpreadBps` float,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `yield_fills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `yield_positions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`depositedAmount` decimal(20,6) NOT NULL,
	`shares` decimal(30,12) NOT NULL,
	`status` enum('active','pending_withdraw','withdrawn','paused') NOT NULL DEFAULT 'active',
	`ownerAddress` varchar(42) NOT NULL,
	`depositTxHash` varchar(66),
	`withdrawTxHash` varchar(66),
	`withdrawnAmount` decimal(20,6),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `yield_positions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_yield_cycle_created` ON `yield_cycles` (`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_yield_fill_cycle` ON `yield_fills` (`cycleId`);--> statement-breakpoint
CREATE INDEX `idx_yield_fill_tx` ON `yield_fills` (`txHash`);--> statement-breakpoint
CREATE INDEX `idx_yield_pos_user` ON `yield_positions` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_yield_pos_status` ON `yield_positions` (`status`);