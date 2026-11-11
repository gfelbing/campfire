import { describe, expect, it } from "vitest";
import { lineReader } from "./connection";
import { encodeLine } from "./types";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("lineReader", () => {
  it("emits each complete \\n-terminated line and keeps partials", () => {
    const lines: string[] = [];
    const feed = lineReader((l) => lines.push(l));
    // First chunk ends mid-line: it stays buffered until the newline.
    feed(bytes('{"a":1}'));
    feed(bytes('\n{"b":2}\n\n'));
    // A trailing bare newline contributes no empty line.
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("carries a multibyte character split across chunks", () => {
    const lines: string[] = [];
    const feed = lineReader((l) => lines.push(l));
    const full = bytes('{"t":"héllo"}\n');
    // Split inside `é` (U+00E9 = 0xC3 0xA9): the streaming decoder must
    // reassemble it instead of emitting U+FFFD.
    const i = full.indexOf(0xc3);
    expect(i).toBeGreaterThan(0);
    feed(full.slice(0, i + 1));
    feed(full.slice(i + 1));
    expect(lines).toEqual(['{"t":"héllo"}']);
  });
});

describe("encodeLine", () => {
  it("JSON-encodes one message plus a trailing newline", () => {
    const out = new TextDecoder().decode(encodeLine({ t: "chat", n: 1 }));
    expect(out).toBe('{"t":"chat","n":1}\n');
  });
});
