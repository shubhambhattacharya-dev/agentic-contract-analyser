import { describe, expect, it } from "vitest";

import { parseSseFrame } from "../api";

describe("parseSseFrame", () => {
  it("parses a token event", () => {
    const events = parseSseFrame('data: {"type":"token","text":"Hello"}');

    expect(events).toEqual([{ type: "token", text: "Hello" }]);
  });

  it("SSE02: concatenation-safe — each token parses independently", () => {
    const events = [
      ...parseSseFrame('data: {"type":"token","text":"Hel"}'),
      ...parseSseFrame('data: {"type":"token","text":"lo"}'),
    ];

    expect(events.map((event) => (event as { text: string }).text).join("")).toBe(
      "Hello",
    );
  });

  it("parses agent_step with round and tool", () => {
    const events = parseSseFrame(
      'data: {"type":"agent_step","round":2,"tool":"search_document","message":"Searching…"}',
    );

    expect(events[0]).toMatchObject({
      type: "agent_step",
      round: 2,
      tool: "search_document",
      message: "Searching…",
    });
  });

  it("parses quote_verified with the full source payload", () => {
    const source = {
      chunkId: "c1",
      parentId: null,
      quote: "q",
      verified: true,
      documentId: "d1",
      startOffset: 3,
      endOffset: 4,
      page: 2,
      occurrences: 1,
    };

    const events = parseSseFrame(
      `data: ${JSON.stringify({ type: "quote_verified", source })}`,
    );

    expect(events[0]).toEqual({ type: "quote_verified", source });
  });

  it("parses quote_rejected, notice, done and error events", () => {
    expect(parseSseFrame('data: {"type":"quote_rejected","quote":"x"}')[0])
      .toMatchObject({ type: "quote_rejected", quote: "x" });

    expect(
      parseSseFrame(
        'data: {"type":"notice","kind":"unverified_removed","text":"1 quote removed"}',
      )[0],
    ).toMatchObject({ type: "notice", kind: "unverified_removed" });

    const done = parseSseFrame(
      'data: {"type":"done","message":{"id":"m","role":"assistant","content":"a","createdAt":"t"},"stopped":true}',
    )[0];

    expect(done).toMatchObject({ type: "done", stopped: true });

    expect(parseSseFrame('data: {"type":"error","message":"boom"}')[0]).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("SSE10: malformed payloads and comments never crash — ignored gracefully", () => {
    expect(parseSseFrame("data: {not json")).toEqual([]);
    expect(parseSseFrame(": heartbeat")).toEqual([]);
    expect(parseSseFrame("")).toEqual([]);
    expect(parseSseFrame('data: {"type":"mystery"}')).toEqual([
      { type: "unknown" },
    ]);
  });

  it("JSON string content with newlines/quotes survives parsing", () => {
    const events = parseSseFrame(
      'data: {"type":"token","text":"line\\nbreak \\"quoted\\""}',
    );

    expect((events[0] as { text: string }).text).toBe('line\nbreak "quoted"');
  });
});
