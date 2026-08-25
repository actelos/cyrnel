ALTER TABLE `modules` ADD `created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
CREATE INDEX `modules_created_at_idx` ON `modules` (`created_at`);--> statement-breakpoint
ALTER TABLE `services` ADD `created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
CREATE INDEX `services_created_at_idx` ON `services` (`created_at`);