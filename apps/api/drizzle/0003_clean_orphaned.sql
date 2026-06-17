ALTER TABLE `modules` RENAME COLUMN `orphaned` TO `missing`;--> statement-breakpoint
ALTER TABLE `services` DROP COLUMN `orphaned`;
