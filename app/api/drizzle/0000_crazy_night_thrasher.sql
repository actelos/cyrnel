CREATE TABLE `manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`metadata` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `manifests_type_idx` ON `manifests` (`type`);--> statement-breakpoint
CREATE TABLE `tools` (
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`input_schema` text NOT NULL,
	`output_schema` text NOT NULL,
	`metadata` text NOT NULL,
	PRIMARY KEY(`service_id`, `name`),
	FOREIGN KEY (`service_id`) REFERENCES `manifests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tools_name_idx` ON `tools` (`name`);