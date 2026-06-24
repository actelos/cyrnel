CREATE TABLE `process_data` (
	`process_id` integer PRIMARY KEY NOT NULL,
	`exit_state` text,
	`error` text,
	`output` text DEFAULT '{}' NOT NULL,
	`stdout` text,
	`stderr` text,
	`completed_at` text NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `processes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ref` text,
	`description` text DEFAULT '' NOT NULL,
	`code` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processes_ref_unique` ON `processes` (`ref`);