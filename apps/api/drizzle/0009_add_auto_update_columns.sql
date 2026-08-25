ALTER TABLE `modules` ADD COLUMN `auto_update` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `modules` ADD COLUMN `auto_update_constraint` text;
--> statement-breakpoint
ALTER TABLE `services` ADD COLUMN `auto_update` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `services` ADD COLUMN `auto_update_constraint` text;
