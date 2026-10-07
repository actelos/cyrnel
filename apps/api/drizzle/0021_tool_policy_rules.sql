-- Replace per-tool policies with ordered pattern rules.
-- Rules are evaluated in ascending position order; the first match wins.
-- Only non-default (allow/block) rows are migrated, in deterministic
-- (service_id, tool_id) order; explicit ask rows already equal the
-- immutable ask default and are discarded. Timestamps are preserved.
CREATE TABLE `tool_policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`service_pattern` text NOT NULL,
	`tool_pattern` text NOT NULL,
	`decision` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_policy_rules_position_idx` ON `tool_policy_rules` (`position`);--> statement-breakpoint
INSERT INTO `tool_policy_rules` (`id`, `service_pattern`, `tool_pattern`, `decision`, `position`, `created_at`, `updated_at`) SELECT 'tpr_migrated_' || `service_id` || '__' || `tool_id`, `service_id`, `tool_id`, `decision`, ROW_NUMBER() OVER (ORDER BY `service_id`, `tool_id`) - 1, `created_at`, COALESCE(`updated_at`, CAST(strftime('%s', 'now') * 1000 AS INTEGER)) FROM `tool_policies` WHERE `decision` <> 'ask';
--> statement-breakpoint
DROP TABLE `tool_policies`;
