CREATE TABLE `module_connection_schemes` (
	`connection_id` text NOT NULL,
	`scheme_name` text NOT NULL,
	`module_id` text NOT NULL,
	PRIMARY KEY(`connection_id`, `scheme_name`, `module_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `module_connection_schemes_module_idx` ON `module_connection_schemes` (`module_id`,`scheme_name`);