CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`process_id` integer,
	`parameters` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approval_requests_state_idx` ON `approval_requests` (`state`);--> statement-breakpoint
CREATE INDEX `approval_requests_created_idx` ON `approval_requests` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `approval_requests_expiry_idx` ON `approval_requests` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `approval_requests_decided_idx` ON `approval_requests` (`state`,`decided_at`);--> statement-breakpoint
CREATE TABLE `tool_policies` (
	`service_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`service_id`, `tool_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `processes` ADD `state` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
UPDATE `processes` SET `state` = 'running' WHERE `id` NOT IN (SELECT `process_id` FROM `process_data`);--> statement-breakpoint
INSERT OR IGNORE INTO `tool_policies` (`service_id`, `tool_id`, `decision`, `created_at`, `updated_at`) SELECT `service_id`, `id`, CASE WHEN `enabled` THEN 'allow' ELSE 'ask' END, strftime('%Y-%m-%dT%H:%M:%fZ','now'), CASE WHEN `enabled` THEN unixepoch()*1000 ELSE NULL END FROM `tools`;