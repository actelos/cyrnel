(() => {
  interface IvmReference {
    applyIgnored(receiver: undefined, args: unknown[]): void;
  }

  const emitStdout = (
    globalThis as typeof globalThis & {
      __cyrnel_emitStdout: IvmReference;
    }
  ).__cyrnel_emitStdout;

  const formatArgs = (...args: unknown[]): string => {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg === null) return "null";
        if (arg === undefined) return "undefined";
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
  };

  const consoleLike = console as unknown as Record<string, unknown>;

  for (const name of [
    "assert",
    "clear",
    "count",
    "countReset",
    "debug",
    "dir",
    "dirxml",
    "group",
    "groupCollapsed",
    "groupEnd",
    "info",
    "profile",
    "profileEnd",
    "table",
    "time",
    "timeEnd",
    "timeLog",
    "timeStamp",
    "trace",
    "warn",
  ]) {
    consoleLike[name] = (...args: unknown[]) => {
      emitStdout.applyIgnored(undefined, [`${name}: ${formatArgs(...args)}\n`]);
    };
  }
})();
