DROP INDEX `modules_created_at_idx`;--> statement-breakpoint
CREATE INDEX `modules_created_at_idx` ON `modules` (`created_at`,`id`);--> statement-breakpoint
DROP INDEX `services_created_at_idx`;--> statement-breakpoint
CREATE INDEX `services_created_at_idx` ON `services` (`created_at`,`id`);