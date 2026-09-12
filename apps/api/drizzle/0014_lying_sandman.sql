PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`token_url` text NOT NULL,
	`authorization_url` text,
	`client_auth_method` text DEFAULT 'client_secret_basic' NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_oauth_clients`("id", "client_id", "client_secret", "token_url", "authorization_url", "client_auth_method", "redirect_uris", "created_at", "updated_at") SELECT "id", "client_id", "client_secret", "token_url", "authorization_url", "client_auth_method", "redirect_uris", "created_at", "updated_at" FROM `oauth_clients`;--> statement-breakpoint
DROP TABLE `oauth_clients`;--> statement-breakpoint
ALTER TABLE `__new_oauth_clients` RENAME TO `oauth_clients`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `connections` ADD `oauth_client_id` text REFERENCES oauth_clients(id);--> statement-breakpoint
ALTER TABLE `connections` ADD `scopes` text;