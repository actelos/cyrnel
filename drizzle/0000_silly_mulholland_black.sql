CREATE TABLE `manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`input_schema` text NOT NULL,
	`output_schema` text NOT NULL,
	`metadata` text NOT NULL,
	PRIMARY KEY(`service_id`, `name`),
	FOREIGN KEY (`service_id`) REFERENCES `manifests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tools_name_idx` ON `tools` (`name`);