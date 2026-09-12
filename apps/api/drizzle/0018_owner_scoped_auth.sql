DROP TABLE IF EXISTS `connection_schemes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `module_connection_schemes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `pending_authorizations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `connection_auth`;
--> statement-breakpoint
DROP TABLE IF EXISTS `connections`;
--> statement-breakpoint
DROP TABLE IF EXISTS `registry_auth`;
--> statement-breakpoint
CREATE TABLE `oauth_clients_new` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`token_url` text NOT NULL,
	`authorization_url` text,
	`client_auth_method` text DEFAULT 'client_secret_basic' NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`available_scopes` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `oauth_clients_new` (`id`, `provider`, `client_id`, `client_secret`, `token_url`, `authorization_url`, `client_auth_method`, `redirect_uris`, `available_scopes`, `created_at`, `updated_at`) SELECT `id`, 'custom', `client_id`, `client_secret`, `token_url`, `authorization_url`, `client_auth_method`, `redirect_uris`, '[]', `created_at`, `updated_at` FROM `oauth_clients`;
--> statement-breakpoint
DROP TABLE `oauth_clients`;
--> statement-breakpoint
ALTER TABLE `oauth_clients_new` RENAME TO `oauth_clients`;
--> statement-breakpoint
CREATE TABLE `service_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`scheme_name` text NOT NULL,
	`scheme_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`oauth_client_id` text,
	`requested_scopes` text DEFAULT '[]',
	`granted_scopes` text,
	`granted_source` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `service_credential_auth` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`scheme_type` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `service_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_credentials_owner_scheme_unique` ON `service_credentials` (`service_id`,`scheme_name`);
--> statement-breakpoint
CREATE INDEX `service_credentials_client_idx` ON `service_credentials` (`oauth_client_id`);
--> statement-breakpoint
CREATE TABLE `module_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`scheme_name` text NOT NULL,
	`scheme_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`oauth_client_id` text,
	`requested_scopes` text DEFAULT '[]',
	`granted_scopes` text,
	`granted_source` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `module_credential_auth` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`scheme_type` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `module_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `module_credentials_owner_scheme_unique` ON `module_credentials` (`module_id`,`scheme_name`);
--> statement-breakpoint
CREATE INDEX `module_credentials_client_idx` ON `module_credentials` (`oauth_client_id`);
--> statement-breakpoint
CREATE TABLE `registry_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`registry_id` text NOT NULL,
	`scheme_name` text NOT NULL,
	`scheme_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`oauth_client_id` text,
	`requested_scopes` text DEFAULT '[]',
	`granted_scopes` text,
	`granted_source` text,
	`created_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`registry_id`) REFERENCES `registries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`oauth_client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `registry_credential_auth` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`scheme_type` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `registry_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registry_credentials_owner_scheme_unique` ON `registry_credentials` (`registry_id`,`scheme_name`);
--> statement-breakpoint
CREATE INDEX `registry_credentials_client_idx` ON `registry_credentials` (`oauth_client_id`);
--> statement-breakpoint
CREATE TABLE `oauth_pendings` (
	`state` text PRIMARY KEY NOT NULL,
	`service_credential_id` text,
	`module_credential_id` text,
	`registry_credential_id` text,
	`code_verifier` text NOT NULL,
	`code_challenge` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`requested_scopes` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`service_credential_id`) REFERENCES `service_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_credential_id`) REFERENCES `module_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`registry_credential_id`) REFERENCES `registry_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	CHECK (((`service_credential_id` IS NOT NULL) + (`module_credential_id` IS NOT NULL) + (`registry_credential_id` IS NOT NULL)) = 1)
);
--> statement-breakpoint
CREATE INDEX `oauth_pendings_expiry_idx` ON `oauth_pendings` (`expires_at`);
-- 0018 destroys legacy auth secrets (connections, registry_auth); see RFC-authentication.md section 11.
