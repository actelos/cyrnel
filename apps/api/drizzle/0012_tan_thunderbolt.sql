CREATE TABLE `connection_auth` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`scheme_type` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connection_schemes` (
	`connection_id` text NOT NULL,
	`scheme_name` text NOT NULL,
	`service_id` text NOT NULL,
	PRIMARY KEY(`connection_id`, `scheme_name`, `service_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `connection_schemes_service_idx` ON `connection_schemes` (`service_id`,`scheme_name`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scheme_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`token_url` text NOT NULL,
	`authorization_url` text,
	`client_auth_method` text DEFAULT 'client_secret_basic' NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_authorizations` (
	`state` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`code_verifier` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_auth_expiry_idx` ON `pending_authorizations` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tool_policies` (
	`service_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`service_id`, `tool_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tool_policies`("service_id", "tool_id", "decision", "created_at", "updated_at") SELECT "service_id", "tool_id", "decision", "created_at", "updated_at" FROM `tool_policies`;--> statement-breakpoint
DROP TABLE `tool_policies`;--> statement-breakpoint
ALTER TABLE `__new_tool_policies` RENAME TO `tool_policies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `approval_requests_process_id_idx` ON `approval_requests` (`process_id`);