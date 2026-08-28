CREATE TABLE `discussion_enrichment` (
	`discussion_id` text PRIMARY KEY NOT NULL,
	`title` text,
	`summary` text,
	`topics` text,
	`entities` text,
	`key_points` text,
	`sentiment` text,
	`sentiment_score` real,
	`language` text,
	`discussion_type` text,
	`resolved` integer,
	`embedding` blob,
	`raw_llm_response` text,
	`enriched_at` text NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions_local`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `discussions_local` ADD `parent_discussion_id` text;--> statement-breakpoint
CREATE INDEX `idx_discussions_parent` ON `discussions_local` (`parent_discussion_id`);