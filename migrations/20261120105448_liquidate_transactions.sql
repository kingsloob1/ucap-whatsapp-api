PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`user_id` integer NOT NULL,
	`type` text NOT NULL,
	`product_code` text,
	`amount_kobo` integer NOT NULL,
	`note` text,
	`status` text DEFAULT 'successful' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transactions_type_known" CHECK("__new_transactions"."type" IN ('fund', 'withdraw', 'buy', 'liquidate')),
	CONSTRAINT "transactions_amount_positive" CHECK("__new_transactions"."amount_kobo" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "reference", "user_id", "type", "product_code", "amount_kobo", "note", "status", "created_at") SELECT "id", "reference", "user_id", "type", "product_code", "amount_kobo", "note", "status", "created_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_reference_unique` ON `transactions` (`reference`);--> statement-breakpoint
CREATE INDEX `ix_transactions_user` ON `transactions` (`user_id`,`created_at`);