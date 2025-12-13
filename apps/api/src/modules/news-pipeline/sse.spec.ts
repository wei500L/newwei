import { Readable } from "node:stream";

import { iterateSseDataFromReadable } from "./sse";

async function collect(generator: AsyncGenerator<string>): Promise<string[]> {
  const results: string[] = [];
  for await (const value of generator) {
    results.push(value);
  }
  return results;
}

describe("iterateSseDataFromReadable", () => {
  it("parses events split across chunks", async () => {
    const stream = Readable.from([
      Buffer.from('data: {"a":', "utf-8"),
      Buffer.from('1}\n\n', "utf-8")
    ]);

    await expect(collect(iterateSseDataFromReadable(stream))).resolves.toEqual([
      '{"a":1}'
    ]);
  });

  it("handles CRLF and CRLF split across chunk boundary", async () => {
    const stream = Readable.from([
      Buffer.from("data: hello\r", "utf-8"),
      Buffer.from("\n\r\n", "utf-8")
    ]);

    await expect(collect(iterateSseDataFromReadable(stream))).resolves.toEqual([
      "hello"
    ]);
  });

  it("handles CR-only newlines", async () => {
    const stream = Readable.from([Buffer.from("data: hi\r\r", "utf-8")]);

    await expect(collect(iterateSseDataFromReadable(stream))).resolves.toEqual([
      "hi"
    ]);
  });

  it("joins multi-line data fields within one event", async () => {
    const stream = Readable.from([
      Buffer.from("data: line1\ndata: line2\n\n", "utf-8")
    ]);

    await expect(collect(iterateSseDataFromReadable(stream))).resolves.toEqual([
      "line1\nline2"
    ]);
  });

  it("does not break when UTF-8 sequences are split across chunks", async () => {
    const full = Buffer.from("data: 你\n\n", "utf-8");
    const stream = Readable.from([full.subarray(0, 7), full.subarray(7)]);

    await expect(collect(iterateSseDataFromReadable(stream))).resolves.toEqual([
      "你"
    ]);
  });

  it("flushes a trailing event even without a blank line terminator", async () => {
    const stream = Readable.from([Buffer.from("data: tail\n", "utf-8")]);

    await expect(collect(iterateSseDataFromReadable(stream))).resolves.toEqual([
      "tail"
    ]);
  });
});

