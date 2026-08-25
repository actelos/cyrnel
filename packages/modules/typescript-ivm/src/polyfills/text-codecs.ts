(() => {
  class TextEncoderImpl {
    readonly encoding = "utf-8";

    encode(input?: string): Uint8Array {
      const str = String(input ?? "");
      const bytes: number[] = [];
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            i += 1;
          } else {
            code = 0xfffd;
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          code = 0xfffd;
        }

        if (code <= 0x7f) {
          bytes.push(code);
        } else if (code <= 0x7ff) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code <= 0xffff) {
          bytes.push(
            0xe0 | (code >> 12),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        } else {
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        }
      }
      return Uint8Array.from(bytes);
    }
  }

  class TextDecoderImpl {
    readonly encoding = "utf-8";
    readonly fatal = false;
    readonly ignoreBOM = false;

    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (input === undefined) return "";
      const view = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      const bytes = view;

      let result = "";
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i];
        if (b0 < 0x80) {
          result += String.fromCharCode(b0);
          i += 1;
          continue;
        }

        let code: number;
        let length: number;
        if (b0 >= 0xc2 && b0 <= 0xdf) {
          code = b0 & 0x1f;
          length = 2;
        } else if (b0 >= 0xe0 && b0 <= 0xef) {
          code = b0 & 0x0f;
          length = 3;
        } else if (b0 >= 0xf0 && b0 <= 0xf4) {
          code = b0 & 0x07;
          length = 4;
        } else {
          result += "\ufffd";
          i += 1;
          continue;
        }

        let valid = i + length <= bytes.length;
        for (let j = 1; j < length && valid; j++) {
          const b = bytes[i + j];
          if ((b & 0xc0) !== 0x80) {
            valid = false;
          } else {
            code = (code << 6) | (b & 0x3f);
          }
        }

        if (
          !valid ||
          (length === 2 && code < 0x80) ||
          (length === 3 && code < 0x800) ||
          (length === 4 && (code < 0x10000 || code > 0x10ffff)) ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          result += "\ufffd";
          i += 1;
          continue;
        }

        result +=
          code <= 0xffff
            ? String.fromCharCode(code)
            : String.fromCodePoint(code);
        i += length;
      }
      return result;
    }
  }

  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoderImpl,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoderImpl,
    writable: true,
    configurable: true,
  });
})();
