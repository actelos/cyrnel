(() => {
  Object.defineProperty(globalThis, "queueMicrotask", {
    value: (callback: () => void): void => {
      Promise.resolve().then(() => callback());
    },
    writable: true,
    configurable: true,
  });
})();
