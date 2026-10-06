-- Remove OAuth client availableScopes column.
-- Values are intentionally discarded (not migrated to credential-level scopes).
-- Scopes now flow from service/module-declared scopes to user-requested scopes
-- to provider-granted scopes.
ALTER TABLE `oauth_clients` DROP COLUMN `available_scopes`;
