CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`context` text,
	`channel_id` text,
	`job_id` text,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_llm_calls_started` ON `llm_calls` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_llm_calls_model` ON `llm_calls` (`model`);