CREATE TABLE `registry_auth` (
	`registry_id` text PRIMARY KEY NOT NULL,
	`auth_type` text NOT NULL,
	`config` text NOT NULL,
	`token` text,
	`token_endpoint` text,
	`header_name` text,
	`token_expires_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`registry_id`) REFERENCES `registries`(`id`) ON UPDATE no action ON DELETE cascade
);
