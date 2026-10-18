import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "../src/providers/codex.js";
import { parseAgyJson } from "../src/providers/antigravity.js";

describe("parseCodexJsonl", () => {
  it("extracts the last agent message and sums usage", () => {
    const out = [
      '{"type":"thread.started","thread_id":"0199a213"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs."}}',
      '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"cache_write_input_tokens":0,"output_tokens":122,"reasoning_output_tokens":10}}',
    ].join("\n");
    const p = parseCodexJsonl(out);
    expect(p.finalMessage).toBe("Repo contains docs.");
    expect(p.threadId).toBe("0199a213");
    expect(p.usage).toEqual({ inputTokens: 24763, cachedInputTokens: 24448, outputTokens: 132 });
    expect(p.errors).toEqual([]);
    expect(p.eventCount).toBe(6);
  });

  it("tolerates stray non-JSON lines, CRLF and missing optional usage fields", () => {
    const out = 'warning: something\r\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\r\n{"type":"turn.completed","usage":{"input_tokens":5}}\r\n';
    const p = parseCodexJsonl(out);
    expect(p.finalMessage).toBe("ok");
    expect(p.invalidLines).toBe(1);
    expect(p.usage).toEqual({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 0 });
  });

  it("collects error events and turn failures", () => {
    const out = '{"type":"error","message":"429 Too Many Requests"}\n{"type":"turn.failed","error":{"message":"rate limit"}}\n{"type":"item.completed","item":{"type":"error","message":"tool failed"}}';
    const p = parseCodexJsonl(out);
    expect(p.errors).toEqual(["429 Too Many Requests", "rate limit", "tool failed"]);
    expect(p.finalMessage).toBe("");
  });

  it("ignores JSON values that are not objects", () => {
    const p = parseCodexJsonl('42\n"str"\n[1,2]\n');
    expect(p.eventCount).toBe(0);
    expect(p.invalidLines).toBe(3);
  });

  it("sums usage across multiple turns", () => {
    const out = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}';
    expect(parseCodexJsonl(out).usage).toEqual({ inputTokens: 4, cachedInputTokens: 0, outputTokens: 6 });
  });
});

describe("parseAgyJson", () => {
  it("finds the envelope after noise", () => {
    const r = parseAgyJson('progress...\n{"conversation_id":"c","status":"SUCCESS","response":"hi","usage":{"input_tokens":3,"output_tokens":4}}\n');
    expect(r).toEqual({ response: "hi", status: "SUCCESS", usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 } });
  });
  it("returns undefined without an envelope", () => {
    expect(parseAgyJson("plain text")).toBeUndefined();
  });
});
