ALTER TABLE `manifests` ADD COLUMN `config_schema` text NOT NULL DEFAULT '{"type":null}';
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`config_schema` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `manifests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `services` (`id`, `config_schema`)
SELECT `id`, `config_schema` FROM `manifests`;
--> statement-breakpoint
CREATE TABLE `service_configs` (
	`service_name` text PRIMARY KEY NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_name`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
