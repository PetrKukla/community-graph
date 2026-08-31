PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`display_name` text,
	`first_seen_at` text,
	`last_seen_at` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`names_synced_at` text
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "display_name", "first_seen_at", "last_seen_at", "message_count", "names_synced_at") SELECT "id", "username", "display_name", "first_seen_at", "last_seen_at", "message_count", "names_synced_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `channels` ADD `names_synced_at` text;--> statement-breakpoint
ALTER TABLE `guilds` ADD `names_synced_at` text;