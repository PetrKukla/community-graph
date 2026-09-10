CREATE TABLE `query_history` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`filters` text,
	`answer` text NOT NULL,
	`confidence` text NOT NULL,
	`used_discussion_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_query_history_created` ON `query_history` (`created_at`);