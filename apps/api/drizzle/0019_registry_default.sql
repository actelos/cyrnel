-- At most one registry may be the default (is_default = 1). SQLite has no
-- partial unique index for this, so the invariant is enforced in application
-- transactions (RegistriesService): setting a default clears all others in the
-- same transaction, and deleting the default auto-promotes the oldest
-- remaining registry (by created_at) or leaves no default when none remain.
-- Existing rows keep is_default = 0; no silent default is assigned.
ALTER TABLE `registries` ADD COLUMN `is_default` integer DEFAULT 0 NOT NULL;
