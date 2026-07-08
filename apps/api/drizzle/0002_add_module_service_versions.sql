ALTER TABLE `modules` ADD COLUMN `version` text DEFAULT '0.0.0' NOT NULL;
--> statement-breakpoint
ALTER TABLE `services` ADD COLUMN `version` text DEFAULT '0.0.0' NOT NULL;
