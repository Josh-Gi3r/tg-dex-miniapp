CREATE TABLE `social_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`platform` enum('x','whatsapp','gmail','instagram','linkedin') NOT NULL,
	`handle` varchar(256) NOT NULL,
	`isVerified` boolean NOT NULL DEFAULT false,
	`xpAwarded` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_links_id` PRIMARY KEY(`id`)
);
