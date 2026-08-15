(() => {
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const LOOKUP = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    LOOKUP[ALPHABET.charCodeAt(i)] = i;
  }

  const toBase64 = (input: string): string => {
    const str = String(input);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code > 0xff) {
        throw new TypeError(
          "btoa: character cannot be encoded as a single byte",
        );
      }
      bytes[i] = code;
    }

    let output = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      output += ALPHABET[b0 >> 2];
      output += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      output +=
        i + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
      output += i + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : "=";
    }
    return output;
  };

  const fromBase64 = (input: string): string => {
    const str = String(input).replace(/[\t\n\f\r ]/g, "");
    if (str.length % 4 !== 0) {
      throw new TypeError("atob: invalid base64 string");
    }
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        str,
      )
    ) {
      throw new TypeError("atob: invalid base64 string");
    }

    const out: number[] = [];
    for (let i = 0; i < str.length; i += 4) {
      const c0 = LOOKUP[str.charCodeAt(i)];
      const c1 = LOOKUP[str.charCodeAt(i + 1)];
      const c2 = str[i + 2] === "=" ? 0 : LOOKUP[str.charCodeAt(i + 2)];
      const c3 = str[i + 3] === "=" ? 0 : LOOKUP[str.charCodeAt(i + 3)];
      out.push((c0 << 2) | (c1 >> 4));
      if (str[i + 2] !== "=") {
        out.push(((c1 & 0x0f) << 4) | (c2 >> 2));
      }
      if (str[i + 3] !== "=") {
        out.push(((c2 & 0x03) << 6) | c3);
      }
    }

    let result = "";
    for (const byte of out) {
      result += String.fromCharCode(byte);
    }
    return result;
  };

  Object.defineProperty(globalThis, "btoa", {
    value: toBase64,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "atob", {
    value: fromBase64,
    writable: true,
    configurable: true,
  });
})();
