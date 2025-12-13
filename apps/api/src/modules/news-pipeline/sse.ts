import { Readable } from "node:stream";
import { TextDecoder } from "node:util";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

class SseParser {
  private pendingText = "";
  private skipNextLf = false;

  private currentEvent: {
    event?: string;
    dataLines: string[];
    id?: string;
    retry?: number;
  } = { dataLines: [] };

  private dispatchEvent(): SseEvent | undefined {
    if (this.currentEvent.dataLines.length === 0) {
      this.currentEvent = { dataLines: [] };
      return undefined;
    }
    const event: SseEvent = {
      event: this.currentEvent.event,
      data: this.currentEvent.dataLines.join("\n"),
      id: this.currentEvent.id,
      retry: this.currentEvent.retry
    };
    this.currentEvent = { dataLines: [] };
    return event;
  }

  private processLine(line: string, events: SseEvent[]) {
    if (line.length === 0) {
      const event = this.dispatchEvent();
      if (event) {
        events.push(event);
      }
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      this.currentEvent.dataLines.push(value);
      return;
    }
    if (field === "event") {
      this.currentEvent.event = value;
      return;
    }
    if (field === "id") {
      if (!value.includes("\0")) {
        this.currentEvent.id = value;
      }
      return;
    }
    if (field === "retry") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        this.currentEvent.retry = parsed;
      }
    }
  }

  feed(text: string): SseEvent[] {
    const events: SseEvent[] = [];

    let chunkText = text;
    if (this.skipNextLf) {
      if (chunkText.startsWith("\n")) {
        chunkText = chunkText.slice(1);
      }
      this.skipNextLf = false;
    }

    const combined = this.pendingText + chunkText;
    this.pendingText = "";

    let lineStart = 0;
    for (let index = 0; index < combined.length; index += 1) {
      const char = combined[index];
      if (char === "\n") {
        const line = combined.slice(lineStart, index);
        this.processLine(line, events);
        lineStart = index + 1;
        continue;
      }

      if (char === "\r") {
        const line = combined.slice(lineStart, index);
        this.processLine(line, events);

        const next = combined[index + 1];
        if (next === "\n") {
          index += 1;
          lineStart = index + 1;
          continue;
        }

        lineStart = index + 1;
        if (index === combined.length - 1) {
          this.skipNextLf = true;
        }
      }
    }

    this.pendingText = combined.slice(lineStart);
    return events;
  }

  end(): SseEvent[] {
    const events: SseEvent[] = [];

    if (this.pendingText.length > 0) {
      this.processLine(this.pendingText, events);
      this.pendingText = "";
    }

    const event = this.dispatchEvent();
    if (event) {
      events.push(event);
    }

    return events;
  }
}

function decodeStreamChunk(
  decoder: TextDecoder,
  chunk: unknown,
): string | undefined {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return decoder.decode(chunk, { stream: true });
  }
  return undefined;
}

export async function* iterateSseDataFromReadable(
  stream: Readable,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();

  for await (const chunk of stream) {
    const decoded = decodeStreamChunk(decoder, chunk);
    if (!decoded) {
      continue;
    }
    for (const event of parser.feed(decoded)) {
      yield event.data;
    }
  }

  const flushed = decoder.decode();
  if (flushed.length > 0) {
    for (const event of parser.feed(flushed)) {
      yield event.data;
    }
  }

  for (const event of parser.end()) {
    yield event.data;
  }
}

