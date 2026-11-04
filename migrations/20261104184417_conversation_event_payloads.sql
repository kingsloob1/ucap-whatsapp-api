ALTER TABLE `conversation_events` ADD `message_id` text;--> statement-breakpoint
ALTER TABLE `conversation_events` ADD `reply_index` integer;--> statement-breakpoint
ALTER TABLE `conversation_events` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `conversation_events` ADD `delivered_at` text;--> statement-breakpoint
CREATE INDEX `ix_conversation_events_message` ON `conversation_events` (`message_id`,`direction`,`reply_index`);