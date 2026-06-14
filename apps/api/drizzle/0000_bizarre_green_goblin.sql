CREATE TABLE `module_configurations` (
	`module_id` text PRIMARY KEY NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `module_secrets` (
	`module_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`hash` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`orphaned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `modules_type_idx` ON `modules` (`type`);--> statement-breakpoint
CREATE TABLE `service_configurations` (
	`service_id` text PRIMARY KEY NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `service_secrets` (
	`service_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`hash` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`adapter` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config_schema` text NOT NULL,
	`secrets_schema` text NOT NULL,
	`adapter_domain` text NOT NULL,
	`orphaned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`adapter`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`service_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`input_schema` text NOT NULL,
	`output_schema` text NOT NULL,
	`adapter_domain` text NOT NULL,
	PRIMARY KEY(`service_id`, `id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tools_name_idx` ON `tools` (`name`);
