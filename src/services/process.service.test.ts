import { beforeEach, describe, expect, it } from "vitest";

import { ProcessService } from "@/services/process.service";
import { HttpError } from "@/models/error";

const getStored = (service: ProcessService, pid: number) =>
  (service as any).processes.get(pid);

const setState = (
  service: ProcessService,
  pid: number,
  state: "queued" | "running" | "idle",
) => {
  const stored = getStored(service, pid);
  stored.process.state = state;
  return stored;
};

describe("ProcessService", () => {
  let service: ProcessService;

  beforeEach(() => {
    service = new ProcessService();
  });

  it("creates processes with queued state and optional ref", () => {
    const pid = service.create("console.log('hi')", "abc");
    const stored = getStored(service, pid);

    expect(stored.process).toEqual({
      pid,
      state: "queued",
      status: null,
      ref: "abc",
    });
  });

  it("lists processes with filters", () => {
    const pidA = service.create("code-a", "alpha");
    const pidB = service.create("code-b", "beta");
    const pidC = service.create("code-c", "beta");

    setState(service, pidA, "idle").process.status = "success";
    setState(service, pidB, "running").process.status = null;
    setState(service, pidC, "idle").process.status = "failed";

    expect(service.list({})).toHaveLength(3);
    expect(
      service
        .list({ state: "idle" })
        .map((p) => p.pid)
        .sort((a, b) => a - b),
    ).toEqual([pidA, pidC].sort((a, b) => a - b));
    expect(service.list({ status: "failed" }).map((p) => p.pid)).toEqual([
      pidC,
    ]);
    expect(
      service
        .list({ ref: "beta" })
        .map((p) => p.pid)
        .sort((a, b) => a - b),
    ).toEqual([pidB, pidC].sort((a, b) => a - b));
    expect(
      service
        .list({ ref: "beta" })
        .map((p) => p.pid)
        .sort(),
    ).toEqual([pidB, pidC].sort());
  });

  it("gets a process and errors on missing pid", () => {
    const pid = service.create("code");
    expect(service.get(pid).pid).toBe(pid);
    expect(() => service.get(999)).toThrowError(HttpError);
  });

  it("guards output access until idle", () => {
    const pid = service.create("code");

    expect(() => service.getOutput(pid)).toThrowError(HttpError);
    expect(() => service.getStdout(pid)).toThrowError(HttpError);
    expect(() => service.getStderr(pid)).toThrowError(HttpError);

    const stored = setState(service, pid, "idle");
    stored.output = { ok: true };
    stored.stdout = "ok";
    stored.stderr = "";

    expect(service.getOutput(pid)).toEqual({ ok: true });
    expect(service.getStdout(pid)).toBe("ok");
    expect(service.getStderr(pid)).toBe("");
  });

  it("kills non-idle processes and rejects idle", () => {
    const pid = service.create("code");

    setState(service, pid, "running");
    const killed = service.kill(pid);
    expect(killed.state).toBe("idle");
    expect(killed.status).toBe("canceled");

    expect(() => service.kill(pid)).toThrowError(HttpError);
  });

  it("runs only idle processes and enforces force on existing outputs", () => {
    const pid = service.create("code");

    expect(() => service.run(pid, false)).toThrowError(HttpError);

    const stored = setState(service, pid, "idle");
    stored.output = { prior: true };
    stored.stdout = "log";

    expect(() => service.run(pid, false)).toThrowError(HttpError);

    const updated = service.run(pid, true);
    expect(updated.state).toBe("queued");
    expect(updated.status).toBe(null);

    const refreshed = getStored(service, pid);
    expect(refreshed.output).toBe(null);
    expect(refreshed.stdout).toBe("");
    expect(refreshed.stderr).toBe("");
  });

  it("deletes only idle processes and reuses pid", () => {
    const pid = service.create("code");

    expect(() => service.delete(pid)).toThrowError(HttpError);

    setState(service, pid, "idle");
    const removed = service.delete(pid);
    expect(removed.pid).toBe(pid);

    const newPid = service.create("next");
    expect(newPid).toBe(pid);
  });
});
