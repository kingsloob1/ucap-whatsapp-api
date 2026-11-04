CREATE TABLE `admins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admins_email_unique` ON `admins` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_admins_username_lower` ON `admins` (lower("username"));--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wa_id` text NOT NULL,
	`source` text NOT NULL,
	`direction` text NOT NULL,
	`step_before` text,
	`step_after` text,
	`text` text,
	`choice_id` text,
	`kind` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "conversation_events_direction_known" CHECK("conversation_events"."direction" IN ('in', 'out'))
);
--> statement-breakpoint
CREATE INDEX `ix_conversation_events_wa` ON `conversation_events` (`wa_id`,`id`);--> statement-breakpoint
CREATE TABLE `conversation_sessions` (
	`wa_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`profile_name` text,
	`phone_number_id` text,
	`step` text,
	`started_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`expires_at` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`ended_at` text,
	`end_reason` text,
	CONSTRAINT "conversation_sessions_source_known" CHECK("conversation_sessions"."source" IN ('whatsapp', 'simulator'))
);
--> statement-breakpoint
CREATE INDEX `ix_conversation_sessions_activity` ON `conversation_sessions` (`last_activity_at`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`user_id` integer NOT NULL,
	`type` text NOT NULL,
	`product_code` text,
	`amount_kobo` integer NOT NULL,
	`status` text DEFAULT 'successful' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "transactions_type_known" CHECK("transactions"."type" IN ('fund', 'withdraw', 'buy')),
	CONSTRAINT "transactions_amount_positive" CHECK("transactions"."amount_kobo" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_reference_unique` ON `transactions` (`reference`);--> statement-breakpoint
CREATE INDEX `ix_transactions_user` ON `transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_products` (
	`user_id` integer NOT NULL,
	`product_code` text NOT NULL,
	`balance_kobo` integer DEFAULT 0 NOT NULL,
	`subscribed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `product_code`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_products_balance_non_negative" CHECK("user_products"."balance_kobo" >= 0)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wa_id` text NOT NULL,
	`name` text,
	`bvn` text NOT NULL,
	`date_of_birth` text NOT NULL,
	`pin_hash` text NOT NULL,
	`wallet_balance_kobo` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "users_wallet_non_negative" CHECK("users"."wallet_balance_kobo" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_wa_id_unique` ON `users` (`wa_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_bvn_unique` ON `users` (`bvn`);