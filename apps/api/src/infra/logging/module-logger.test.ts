import type pino from "pino";
import { describe, expect, it } from "vitest";

import { createModuleLogger } from "@/infra/logging/module-logger";

const REDACTED = "***REDACTED***";

function makeFakePino() {
  let lastData: Record<string, unknown> = {};
  const calls: Array<{
    level: string;
    data: Record<string, unknown>;
    msg?: string;
  }> = [];
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const logger = {
    isLevelEnabled: (_level: string) => true,
    child: () => logger,
  } as unknown as pino.Logger;
  for (const level of levels) {
    (logger as unknown as Record<string, unknown>)[level] = (
      data: Record<string, unknown>,
      msg?: string,
    ) => {
      lastData = data;
      calls.push({ level, data, msg });
    };
  }
  return { logger, getLastData: () => lastData };
}

const baseContext = {
  category: "module" as const,
  moduleId: "mod-1",
  moduleType: "adapter" as const,
  adapterId: "mod-1",
};

describe("createModuleLogger redaction", () => {
  it("always applies the host-enforced baseline by default", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext);
    ml.info(
      {
        headers: { authorization: "Bearer secret" },
        apiKey: "topsecret",
        note: "visible",
      },
      "setup",
    );
    const data = getLastData();
    expect(data.headers).toEqual({ authorization: REDACTED });
    expect(data.apiKey).toBe(REDACTED);
    expect(data.note).toBe("visible");
  });

  it("lets the module add its own patterns via redact()", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext).redact(["user.email"]);
    ml.info({ user: { email: "a@b.c", name: "Jane" } });
    expect(getLastData().user).toEqual({ email: REDACTED, name: "Jane" });
  });

  it("cannot disable the baseline via redact()", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext).redact([]);
    ml.info({ password: "hunter2" });
    expect(getLastData().password).toBe(REDACTED);
  });

  it("applies redact() patterns on child loggers", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext)
      .redact(["traceId"])
      .child({ phase: "invoke" });
    ml.warn({ traceId: "abc", ok: 1 });
    const data = getLastData();
    expect(data.traceId).toBe(REDACTED);
    expect(data.ok).toBe(1);
  });

  it("ignores non-string entries in module patterns", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext).redact([
      "custom",
      42 as unknown as string,
    ]);
    ml.info({ custom: "hide", visible: "show", token: "x" });
    const data = getLastData();
    expect(data.custom).toBe(REDACTED);
    expect(data.visible).toBe("show");
    expect(data.token).toBe(REDACTED);
  });

  it("accumulates patterns across chained redact() calls", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext)
      .redact(["a"])
      .redact(["b"]);
    ml.info({ a: "1", b: "2", c: "3" });
    const data = getLastData();
    expect(data.a).toBe(REDACTED);
    expect(data.b).toBe(REDACTED);
    expect(data.c).toBe("3");
  });

  it("redacts hyphenated API-key header names", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext);
    ml.info({
      headers: { "x-api-key": "secret", "X-API-Key": "secret2" },
    });
    const data = getLastData();
    expect(data.headers).toEqual({
      "x-api-key": REDACTED,
      "X-API-Key": REDACTED,
    });
  });

  it("terminates on module patterns with repeated wildcards", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext).redact(["a*****b"]);
    ml.info({ token: "axb", other: "keep" });
    const data = getLastData();
    expect(data.token).toBe(REDACTED);
    expect(data.other).toBe("keep");
  });

  it("redacts a circular error cause without throwing", () => {
    const { logger, getLastData } = makeFakePino();
    const ml = createModuleLogger(logger, baseContext);
    const err = new Error("boom");
    const cause = new Error("root");
    err.cause = cause;
    (cause as { cause?: unknown }).cause = err;
    expect(() => ml.error({ err })).not.toThrow();
    const data = getLastData();
    expect(data.err).toBeDefined();
    expect(JSON.stringify(data.err)).toContain("[Circular]");
  });
});
