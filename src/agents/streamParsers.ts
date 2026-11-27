import { HttpStatusError } from "./retry.js";
import type { Usage } from "../types.js";

/**
 * Incremental Server-Sent Events decoder: feed it raw text chunks as they
 * arrive, get back the complete `data:` payloads (an event's multiple data
 * lines joined with "\n"). Partial events stay buffered until their blank-
 * line terminator arrives.
 */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const events: string[] = [];
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) events.push(data.join("\n"));
    }
    return events;
  }

  /** Whatever's left when the stream ends without a final blank line. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? this.push(`${rest}\n\n`) : [];
  }
}

/** Splits newline-delimited text into complete lines, buffering a trailing partial line. */
export class LineDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim().length > 0);
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

/** Token counts in a Gemini (stream or not) response, from usageMetadata, if present. */
export function geminiUsageOf(data: any): Usage | undefined {
  const m = data?.usageMetadata;
  if (!m) return undefined;
  return {
    inputTokens: Number(m.promptTokenCount ?? 0),
    outputTokens: Number(m.candidatesTokenCount ?? 0) + Number(m.thoughtsTokenCount ?? 0),
  };
}

/** Anthropic usage blocks count cached input separately; it's still input. */
export function anthropicInputTokens(u: any): number {
  return Number(u?.input_tokens ?? 0) + Number(u?.cache_creation_input_tokens ?? 0) + Number(u?.cache_read_input_tokens ?? 0);
}

/** Usage carried by an Anthropic stream event: message_start has input, message_delta has output. */
export function anthropicStreamUsage(payload: string): { inputTokens?: number; outputTokens?: number } {
  const data = JSON.parse(payload);
  if (data?.type === "message_start" && data.message?.usage) return { inputTokens: anthropicInputTokens(data.message.usage) };
  if (data?.type === "message_delta" && data.usage?.output_tokens !== undefined) return { outputTokens: Number(data.usage.output_tokens) };
  return {};
}

/** Text in one streamGenerateContent SSE payload (a partial GenerateContentResponse). */
export function geminiChunkText(payload: string): string {
  const data = JSON.parse(payload);
  // Carry the error's own HTTP code, so a 503 "high demand" or a 429 inside
  // the stream is retried like one on the initial response — not treated as
  // final (which sent reviews straight to the Claude stand-in).
  if (data?.error) throw new HttpStatusError(Number(data.error.code) || 0, `Gemini stream error: ${JSON.stringify(data.error)}`);
  return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
}

/** Text delta in one Anthropic Messages API stream event, or "" for events without text. */
export function anthropicChunkText(payload: string): string {
  const data = JSON.parse(payload);
  if (data?.type === "error") throw new Error(`Claude stream error: ${JSON.stringify(data.error)}`);
  if (data?.type === "content_block_delta" && data.delta?.type === "text_delta") return data.delta.text ?? "";
  return "";
}

export interface ClaudeCliEvent {
  /** Token-level text, from --include-partial-messages stream events. */
  delta?: string;
  /** Tools the model called in a completed assistant turn (Read, Bash, ...). */
  tools?: string[];
  /** Text of a completed assistant turn — a fallback when there are no partial deltas. */
  assistantText?: string;
  /** The final result line, with the usage and (API-equivalent) cost the CLI reports. */
  result?: { text: string; isError: boolean; usage?: Usage; subtype?: string };
}

/** One line of `claude -p --output-format stream-json --verbose [--include-partial-messages]`. */
export function parseClaudeCliLine(line: string): ClaudeCliEvent {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return {};
  }
  if (obj?.type === "stream_event") {
    const ev = obj.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") return { delta: ev.delta.text ?? "" };
    return {};
  }
  if (obj?.type === "assistant") {
    const blocks: any[] = obj.message?.content ?? [];
    const tools = blocks.filter((b) => b?.type === "tool_use").map((b) => String(b.name ?? "tool"));
    const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
    return { tools: tools.length ? tools : undefined, assistantText: text || undefined };
  }
  if (obj?.type === "result") {
    const isError = obj.is_error === true || (typeof obj.subtype === "string" && obj.subtype !== "success");
    const usage: Usage | undefined = obj.usage
      ? {
          inputTokens: anthropicInputTokens(obj.usage),
          outputTokens: Number(obj.usage.output_tokens ?? 0),
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
        }
      : undefined;
    return { result: { text: typeof obj.result === "string" ? obj.result : "", isError, usage, subtype: typeof obj.subtype === "string" ? obj.subtype : undefined } };
  }
  return {};
}
