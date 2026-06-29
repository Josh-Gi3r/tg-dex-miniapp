ALTER TABLE `p2p_orders` MODIFY COLUMN `status` enum('pending','escrowed','payment_sent','completed','cancelled','disputed','resolved','refunded','filled','expired') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `adId` int;--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `adType` enum('swap','buy','sell') DEFAULT 'swap' NOT NULL;--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `fiatAmount` decimal(18,2);--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `fiatCurrency` varchar(8);--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `paymentMethod` varchar(64);--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `disputeReason` text;--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `adminNote` text;--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `escrowLockedAt` timestamp;--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `paidAt` timestamp;--> statement-breakpoint
ALTER TABLE `p2p_orders` ADD `completedAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `telegramChatId` bigint;