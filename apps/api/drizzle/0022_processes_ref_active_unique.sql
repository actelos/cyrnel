-- `processes.ref` stops being globally unique and becomes a partial unique
-- index scoped to live processes.
--
-- `ref` is a client-supplied correlation label, so the same label may recur
-- across process lifetimes; a global unique index rejected every reuse
-- forever. Uniqueness is now required only while a process is live
-- (queued, running, suspended, terminating), which still prevents forking a
-- live process's ref, while settled processes (idle, terminated) release it.
DROP INDEX IF EXISTS `processes_ref_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `processes_ref_active_unique` ON `processes` (`ref`) WHERE `processes`.`state` IN ('queued', 'running', 'suspended', 'terminating');