ALTER TABLE `processes` ADD COLUMN `timeout_ms` integer;
--> statement-breakpoint
ALTER TABLE `processes` ADD COLUMN `env_config` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE `processes` SET `timeout_ms` = json_extract(`options`, '$.timeoutMs') WHERE json_extract(`options`, '$.timeoutMs') IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `processes` DROP COLUMN `options`;
