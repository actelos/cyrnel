import { describe, expect, it, vi } from "vitest";
import { AutoUpdater, type AutoUpdateTarget } from "./auto-updater";

describe("AutoUpdater", () => {
  it("sweeps targets and updates modules/services when callbacks return true", async () => {
    const targets: AutoUpdateTarget[] = [
      {
        id: "mod1",
        kind: "module",
        source: "registry:mod1",
        version: "1.0.0",
        constraint: "^1.0.0",
      },
      {
        id: "svc1",
        kind: "service",
        source: "registry:svc1",
        version: "2.0.0",
        constraint: null,
      },
      {
        id: "mod2",
        kind: "module",
        source: "registry:mod2",
        version: "1.0.0",
        constraint: null,
      },
      {
        id: "no-src",
        kind: "module",
        source: "",
        version: "1.0.0",
        constraint: null,
      },
    ];

    const listTargets = vi.fn().mockResolvedValue(targets);
    const updateModule = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const updateService = vi.fn().mockResolvedValue(true);

    const updater = new AutoUpdater({
      listTargets,
      updateModule,
      updateService,
    });

    const result = await updater.sweep();

    expect(result).toEqual({
      checked: 3,
      updated: 2,
      failed: 0,
      skipped: 1,
    });
    expect(updateModule).toHaveBeenCalledWith("mod1", "^1.0.0");
    expect(updateService).toHaveBeenCalledWith("svc1", null);
    expect(updateModule).toHaveBeenCalledWith("mod2", null);
  });

  it("handles errors per target gracefully without aborting the sweep", async () => {
    const targets: AutoUpdateTarget[] = [
      {
        id: "failing-mod",
        kind: "module",
        source: "registry:fail",
        version: "1.0.0",
        constraint: null,
      },
      {
        id: "ok-svc",
        kind: "service",
        source: "registry:ok",
        version: "1.0.0",
        constraint: null,
      },
    ];

    const listTargets = vi.fn().mockResolvedValue(targets);
    const updateModule = vi
      .fn()
      .mockRejectedValue(new Error("Registry timeout"));
    const updateService = vi.fn().mockResolvedValue(true);

    const updater = new AutoUpdater({
      listTargets,
      updateModule,
      updateService,
    });

    const result = await updater.sweep();

    expect(result).toEqual({
      checked: 2,
      updated: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it("prevents concurrent sweeps via sweepGuarded", async () => {
    let resolveTargets!: (val: AutoUpdateTarget[]) => void;
    const targetsPromise = new Promise<AutoUpdateTarget[]>((resolve) => {
      resolveTargets = resolve;
    });

    const listTargets = vi.fn().mockReturnValue(targetsPromise);
    const updateModule = vi.fn();
    const updateService = vi.fn();

    const updater = new AutoUpdater({
      listTargets,
      updateModule,
      updateService,
    });

    const p1 = updater.sweepGuarded();
    const p2 = updater.sweepGuarded();

    resolveTargets([]);
    await p1;
    await p2;

    expect(listTargets).toHaveBeenCalledTimes(1);
  });

  it("starts and stops timer cleanly", () => {
    const updater = new AutoUpdater({
      listTargets: vi.fn().mockResolvedValue([]),
      updateModule: vi.fn(),
      updateService: vi.fn(),
    });

    updater.start(60_000);
    updater.start(60_000);
    updater.stop();
    updater.stop();
  });
});
