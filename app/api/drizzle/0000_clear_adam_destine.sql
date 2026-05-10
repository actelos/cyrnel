CREATE TABLE `configurations` (
	`service_name` text PRIMARY KEY NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_name`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`metadata` text NOT NULL,
	`config_schema` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `services_type_idx` ON `services` (`type`);--> statement-breakpoint
CREATE TABLE `tools` (
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`input_schema` text NOT NULL,
	`output_schema` text NOT NULL,
	`metadata` text NOT NULL,
	PRIMARY KEY(`service_id`, `name`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tools_name_idx` ON `tools` (`name`);