CREATE TABLE `channel_checkpoints` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`last_closed_block_end_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text,
	`name` text,
	`type` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discussions_local` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text,
	`block_start_at` text NOT NULL,
	`block_end_at` text NOT NULL,
	`status` text DEFAULT 'clustering' NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`centroid_embedding` blob
);
--> statement-breakpoint
CREATE INDEX `idx_discussions_channel_block` ON `discussions_local` (`channel_id`,`block_end_at`);--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ingestion_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`received_at` text NOT NULL,
	`message_count` integer NOT NULL,
	`inserted_count` integer NOT NULL,
	`duplicate_count` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`channel_id` text,
	`progress_current` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_channel_type` ON `jobs` (`channel_id`,`type`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`guild_id` text,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`reply_to_message_id` text,
	`thread_id` text,
	`mentions` text,
	`attachments_count` integer DEFAULT 0 NOT NULL,
	`word_count` integer NOT NULL,
	`batch_id` text,
	`ingested_at` text NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`discussion_id` text,
	FOREIGN KEY (`batch_id`) REFERENCES `ingestion_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_channel_time` ON `messages` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_reply_to` ON `messages` (`reply_to_message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_processed` ON `messages` (`processed`);--> statement-breakpoint
CREATE INDEX `idx_messages_discussion` ON `messages` (`discussion_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`display_name` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL
);
