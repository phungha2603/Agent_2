import { describe, expect, it } from "vitest";
import { LineDecoder, SseDecoder, anthropicChunkText, geminiChunkText, parseClaudeCliLine } from "../src/agents/streamParsers.js";

describe("SseDecoder", () => {
  it("reassembles events split across arbitrary chunk boundaries, including CRLF", () => {
    const d = new SseDecoder();
    const out = [...d.push('data: {"a"'), ...d.push(":1}\r\n\r\nda"), ...d.push('ta: {"b":2}\n\n')];
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("joins multi-line data and flushes an unterminated final event", () => {
    const d = new SseDecoder();
    expect(d.push("event: x\ndata: line1\ndata: line2\n\ndata: tail")).toEqual(["line1\nline2"]);
    expect(d.flush()).toEqual(["tail"]);
  });
});

describe("LineDecoder", () => {
  it("only emits complete lines", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(":2}\n")).toEqual(['{"b":2}']);
    expect(d.flush()).toEqual([]);
  });
});

describe("geminiChunkText / anthropicChunkText", () => {
  it("extracts streamGenerateContent text parts", () => {
    expect(geminiChunkText(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }, { text: "lo" }] } }] }))).toBe("Hello");
    expect(geminiChunkText(JSON.stringify({ candidates: [{ finishReason: "STOP" }] }))).toBe("");
    expect(() => geminiChunkText(JSON.stringify({ error: { code: 429 } }))).toThrow(/Gemini stream error/);
  });

  it("extracts Anthropic text deltas and ignores other events", () => {
    expect(anthropicChunkText(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }))).toBe("Hi");
    expect(anthropicChunkText(JSON.stringify({ type: "message_start" }))).toBe("");
    expect(() => anthropicChunkText(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }))).toThrow();
  });
});

describe("parseClaudeCliLine", () => {
  // Captured from a real `claude -p --output-format stream-json --verbose --include-partial-messages` run (trimmed).
  const real = [
    '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s"}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"s"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}},"session_id":"s"}',
    '{"type":"assistant","message":{"model":"m","id":"msg","type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"duration_api_ms":802,"stop_reason":"end_turn","session_id":"s","type":"result","subtype":"success","is_error":false,"result":"OK"}',
  ];

  it("turns a real stream into deltas and a final result", () => {
    const events = real.map(parseClaudeCliLine);
    expect(events.map((e) => e.delta).filter(Boolean)).toEqual(["OK"]);
    expect(events[3].assistantText).toBe("OK");
    expect(events[5].result).toEqual({ text: "OK", isError: false });
    expect(events[0]).toEqual({});
  });

  it("reports tool calls and error results, and ignores non-JSON noise", () => {
    expect(parseClaudeCliLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}').tools).toEqual(["Read"]);
    expect(parseClaudeCliLine('{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}').result?.isError).toBe(true);
    expect(parseClaudeCliLine("not json")).toEqual({});
  });
});
