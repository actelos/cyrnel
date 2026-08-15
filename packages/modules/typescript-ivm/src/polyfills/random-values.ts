(() => {
  interface IvmReference {
    applySync(receiver: undefined, args: unknown[]): unknown;
  }

  const __cyrnel_randomBytes = (
    globalThis as typeof globalThis & {
      __cyrnel_randomBytes: IvmReference;
    }
  ).__cyrnel_randomBytes;

  const randomBytes = (length: number): number[] => {
    const json = __cyrnel_randomBytes.applySync(undefined, [
      JSON.stringify({ kind: "bytes", length }),
    ]) as string;
    return JSON.parse(json) as number[];
  };

  const cryptoImpl = {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const view = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );
      if (view.byteLength > 65536) {
        throw new RangeError("getRandomValues: length exceeds 65536");
      }
      view.set(randomBytes(view.byteLength));
      return array;
    },

    randomUUID(): string {
      const json = __cyrnel_randomBytes.applySync(undefined, [
        JSON.stringify({ kind: "uuid" }),
      ]) as string;
      return JSON.parse(json) as string;
    },
  };

  Object.defineProperty(globalThis, "crypto", {
    value: Object.freeze(cryptoImpl),
    writable: false,
    configurable: false,
  });
})();
