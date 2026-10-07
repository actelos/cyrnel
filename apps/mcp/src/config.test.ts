import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = process.env.CYRNEL_MCP_APPROVAL_METHOD;

async function loadConfig() {
  vi.resetModules();
  return await import("@/config.js");
}

beforeEach(() => {
  delete process.env.CYRNEL_MCP_APPROVAL_METHOD;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CYRNEL_MCP_APPROVAL_METHOD;
  else process.env.CYRNEL_MCP_APPROVAL_METHOD = ORIGINAL;
});

describe("CYRNEL_MCP_APPROVAL_METHOD", () => {
  it("defaults to elicitation", async () => {
    const { config } = await loadConfig();
    expect(config.approvalMethod).toBe("elicitation");
  });

  it("accepts elicitation", async () => {
    process.env.CYRNEL_MCP_APPROVAL_METHOD = "elicitation";
    const { config } = await loadConfig();
    expect(config.approvalMethod).toBe("elicitation");
  });

  it("accepts manual", async () => {
    process.env.CYRNEL_MCP_APPROVAL_METHOD = "manual";
    const { config } = await loadConfig();
    expect(config.approvalMethod).toBe("manual");
  });

  it("fails startup on an unknown value instead of falling back", async () => {
    process.env.CYRNEL_MCP_APPROVAL_METHOD = "auto";
    await expect(loadConfig()).rejects.toThrow();
  });

  it("fails startup on an empty value", async () => {
    process.env.CYRNEL_MCP_APPROVAL_METHOD = "";
    await expect(loadConfig()).rejects.toThrow();
  });
});
