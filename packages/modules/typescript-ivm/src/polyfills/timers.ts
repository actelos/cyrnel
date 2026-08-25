(() => {
  interface IvmReference {
    applyIgnored(receiver: undefined, args: unknown[]): void;
    applySync(receiver: undefined, args: unknown[]): unknown;
  }

  interface TimerGlobals {
    __cyrnel_setTimer: IvmReference;
    __cyrnel_clearTimer: IvmReference;
  }

  const { __cyrnel_setTimer, __cyrnel_clearTimer } =
    globalThis as typeof globalThis & TimerGlobals;

  type TimerCallback = (...args: unknown[]) => void;

  const pending = new Map<
    number,
    { callback: TimerCallback; args: unknown[]; repeat: boolean }
  >();

  const register = (
    callback: TimerCallback,
    delay: unknown,
    repeat: boolean,
    args: unknown[] = [],
  ): number => {
    if (typeof callback !== "function") {
      throw new TypeError("Timer callback must be a function");
    }
    const ms = Math.max(0, Math.floor(Number(delay) || 0));
    const id = __cyrnel_setTimer.applySync(undefined, [
      JSON.stringify({ delay: ms, repeat }),
    ]) as number;
    pending.set(id, { callback, args, repeat });
    return id;
  };

  const clear = (id: unknown): void => {
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return;
    pending.delete(numeric);
    __cyrnel_clearTimer.applyIgnored(undefined, [String(numeric)]);
  };

  Object.defineProperty(globalThis, "setTimeout", {
    value: (
      callback: TimerCallback,
      delay?: number,
      ..._args: unknown[]
    ): number => register(callback, delay, false, _args),
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "setInterval", {
    value: (
      callback: TimerCallback,
      delay?: number,
      ..._args: unknown[]
    ): number => register(callback, delay, true, _args),
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "clearTimeout", {
    value: clear,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "clearInterval", {
    value: clear,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "__cyrnel_timerDispatch", {
    value: (id: number): void => {
      const entry = pending.get(id);
      if (!entry) return;
      try {
        entry.callback(...entry.args);
      } finally {
        if (!entry.repeat) {
          pending.delete(id);
        }
      }
    },
    writable: false,
    configurable: false,
  });
})();
