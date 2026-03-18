import { describe, expect, it } from "vitest";

import { createApp } from "@/app";
import { errorMiddleware } from "@/middleware/error.middleware";

// NOTE: getRouterStack relies on Express's undocumented internal property _router.stack when calling createApp.
// This approach may break across Express versions, as _router and stack are not part of the public API.
// Consider replacing with indirect tests using real requests if reliability is critical.
const getRouterStack = (app: ReturnType<typeof createApp>) => {
  const router = (app as any)?._router;
  return Array.isArray(router?.stack) ? router.stack : [];
};

describe("createApp", () => {
  it("mounts the processes router", () => {
    const app = createApp();
    const stack = getRouterStack(app);

    const hasProcessesRoute = stack.some(
      (layer: any) =>
        layer?.regexp?.toString?.().includes("/processes") &&
        layer?.name === "router",
    );

    expect(hasProcessesRoute).toBe(true);
  });

  it("registers the error middleware last", () => {
    const app = createApp();
    const stack = getRouterStack(app);
    const last = stack.at(-1);

    expect(last?.handle).toBe(errorMiddleware);
  });
});
