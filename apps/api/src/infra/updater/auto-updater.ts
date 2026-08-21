import { logger } from "@/infra/logging";

export interface AutoUpdateTarget {
  id: string;
  kind: "module" | "service";
  source: string;
  version: string;
  constraint: string | null;
}

export interface AutoUpdateResult {
  checked: number;
  updated: number;
  failed: number;
  skipped: number;
}

export interface UpdateCallbacks {
  listTargets(): Promise<AutoUpdateTarget[]>;
  updateModule(id: string, constraint: string | null): Promise<boolean>;
  updateService(id: string, constraint: string | null): Promise<boolean>;
}

export class AutoUpdater {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly callbacks: UpdateCallbacks) {}

  start(intervalMs: number): void {
    if (this.timer !== null) return;
    if (intervalMs <= 0) return;

    this.timer = setInterval(() => {
      void this.sweepGuarded();
    }, intervalMs);
    this.timer.unref();

    logger.info(
      { event: "auto-updater-started", intervalMs },
      "Auto-updater background task started",
    );
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info(
        { event: "auto-updater-stopped" },
        "Auto-updater background task stopped",
      );
    }
  }

  async sweepGuarded(): Promise<void> {
    if (this.running) {
      logger.debug(
        { event: "auto-update-sweep-skipped" },
        "Auto-update sweep already running; skipping iteration",
      );
      return;
    }
    this.running = true;
    try {
      const stats = await this.sweep();
      logger.info(
        { event: "auto-update-sweep-completed", ...stats },
        `Auto-update sweep finished: ${stats.updated} updated, ${stats.failed} failed, ${stats.skipped} unchanged out of ${stats.checked} checked`,
      );
    } catch (err) {
      logger.error(
        { event: "auto-update-sweep-failed", err },
        "Auto-update sweep encountered an unhandled error",
      );
    } finally {
      this.running = false;
    }
  }

  async sweep(): Promise<AutoUpdateResult> {
    const targets = await this.callbacks.listTargets();
    const stats: AutoUpdateResult = {
      checked: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
    };

    for (const target of targets) {
      if (!target.source || target.source.trim() === "") {
        continue;
      }

      stats.checked++;
      try {
        let updated = false;
        if (target.kind === "module") {
          updated = await this.callbacks.updateModule(
            target.id,
            target.constraint,
          );
        } else {
          updated = await this.callbacks.updateService(
            target.id,
            target.constraint,
          );
        }

        if (updated) {
          stats.updated++;
          logger.info(
            {
              event: "auto-update-success",
              id: target.id,
              kind: target.kind,
              constraint: target.constraint,
            },
            `Auto-updated ${target.kind} '${target.id}'`,
          );
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.failed++;
        logger.warn(
          {
            event: "auto-update-failed",
            id: target.id,
            kind: target.kind,
            err,
          },
          `Failed to auto-update ${target.kind} '${target.id}'`,
        );
      }
    }

    return stats;
  }
}
