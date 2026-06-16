ALTER TABLE `services` ADD `definition_content` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `stale` integer DEFAULT false NOT NULL;