CREATE TABLE `definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`content` blob NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text,
	`hash` text NOT NULL,
	`metadata` text NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manifests_definition_id_unique` ON `manifests` (`definition_id`);--> statement-breakpoint
CREATE INDEX `manifests_definition_id_idx` ON `manifests` (`definition_id`);--> statement-breakpoint
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