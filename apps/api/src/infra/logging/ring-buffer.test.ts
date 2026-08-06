import { describe, expect, it } from "vitest";

import { RingBuffer } from "@/infra/logging/ring-buffer";

describe("RingBuffer", () => {
  it("holds up to its capacity and drops oldest first", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect(buffer.size).toBe(3);
  });

  it("returns copies from toArray", () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    const snapshot = buffer.toArray();
    buffer.push(2);
    expect(snapshot).toEqual([1]);
  });

  it("retains nothing at zero capacity", () => {
    const buffer = new RingBuffer<number>(0);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });
});
