CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`severity` text NOT NULL,
	`level` integer NOT NULL,
	`message` text NOT NULL,
	`request_method` text,
	`request_path` text,
	`status_code` integer,
	`raw` text
);
--> statement-breakpoint
CREATE INDEX `logs_timestamp_idx` ON `logs` (`timestamp_ms`);--> statement-breakpoint
CREATE INDEX `logs_severity_idx` ON `logs` (`severity`);--> statement-breakpoint
CREATE INDEX `logs_message_idx` ON `logs` (`message`);
