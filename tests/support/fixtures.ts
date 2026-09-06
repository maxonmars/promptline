import type { AskResult } from "../../src/ask.ts";
import type { SolveResult } from "../../src/solve.ts";

export function askResult(overrides: Partial<AskResult> = {}): AskResult {
  return {
    answer: "ответ",
    format: "text",
    completionTokens: 10,
    reasoningTokens: 0,
    totalTokens: 30,
    finishReason: "stop",
    stopMarker: null,
    temperature: null,
    thinkingEnabled: true,
    validation: { ok: true },
    ...overrides,
  };
}

export function solveResult(overrides: Partial<SolveResult> = {}): SolveResult {
  const final = overrides.final ?? askResult();

  return {
    strategy: "direct",
    final,
    preparation: null,
    generatedPrompt: null,
    finalValue: null,
    measured: false,
    totalTokens: final.totalTokens,
    reasoningTokens: final.reasoningTokens,
    elapsedMs: 1500,
    hit: null,
    ...overrides,
  };
}
