import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { ask } from "../src/ask.ts";
import { RAW_OPTIONS, type ResponseOptions } from "../src/options.ts";
import { stubClient, systemOf } from "./support/stub-client.ts";

function withOptions(overrides: Partial<ResponseOptions> = {}): ResponseOptions {
  return { ...RAW_OPTIONS, ...overrides };
}

const history: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: "user", content: "прошлый вопрос" },
  { role: "assistant", content: "прошлый ответ" },
];

describe("сборка запроса", () => {
  it("системный блок идёт в голову запроса перед историей, вопрос — последним", async () => {
    const stub = stubClient([{ content: "ответ" }]);

    await ask(stub.client, "модель", history, "вопрос", RAW_OPTIONS);

    expect(stub.calls[0]!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(stub.calls[0]!.messages.at(-1)).toEqual({ role: "user", content: "вопрос" });
    expect(stub.calls[0]!.model).toBe("модель");
  });

  it("extraSystem уходит в системный блок, а не подменяет вопрос", async () => {
    const stub = stubClient([{ content: "ответ" }]);

    await ask(stub.client, "модель", [], "вопрос", RAW_OPTIONS, "ДОПОЛНИТЕЛЬНЫЙ БЛОК");

    expect(systemOf(stub.calls[0]!)).toContain("ДОПОЛНИТЕЛЬНЫЙ БЛОК");
    expect(stub.calls[0]!.messages.at(-1)).toEqual({ role: "user", content: "вопрос" });
  });

  it("незаданные параметры в запрос не попадают", async () => {
    const stub = stubClient([{ content: "ответ" }]);

    await ask(stub.client, "модель", [], "вопрос", RAW_OPTIONS);

    expect(stub.calls[0]!).not.toHaveProperty("max_tokens");
    expect(stub.calls[0]!).not.toHaveProperty("stop");
    expect(stub.calls[0]!).not.toHaveProperty("temperature");
    expect(stub.calls[0]!).not.toHaveProperty("response_format");
    expect(stub.calls[0]!).not.toHaveProperty("thinking");
  });

  it("заданные лимиты и стоп-секвенция уходят в запрос", async () => {
    const stub = stubClient([{ content: "ответ" }]);

    await ask(stub.client, "модель", [], "вопрос", withOptions({ maxTokens: 500, stopMarker: "@@" }));

    expect(stub.calls[0]!.max_tokens).toBe(500);
    expect(stub.calls[0]!.stop).toEqual(["@@"]);
  });

  it("temperature 0 уходит в запрос: ноль — заданное значение, а не отсутствие", async () => {
    const stub = stubClient([{ content: "ответ" }]);

    await ask(stub.client, "модель", [], "вопрос", withOptions({ temperature: 0 }));

    expect(stub.calls[0]!.temperature).toBe(0);
  });

  it("json включает response_format", async () => {
    const stub = stubClient([{ content: "{}" }]);

    await ask(stub.client, "модель", [], "вопрос", withOptions({ format: "json" }));

    expect(stub.calls[0]!.response_format).toEqual({ type: "json_object" });
  });

  it("поле thinking нужно только чтобы выключить рассуждение", async () => {
    const stub = stubClient([{ content: "ответ" }, { content: "ответ" }]);

    await ask(stub.client, "модель", [], "вопрос", withOptions({ thinkingEnabled: true }));
    await ask(stub.client, "модель", [], "вопрос", withOptions({ thinkingEnabled: false }));

    expect(stub.calls[0]!.thinking).toBeUndefined();
    expect(stub.calls[1]!.thinking).toEqual({ type: "disabled" });
  });
});

describe("разбор ответа", () => {
  it("переносит расход токенов и режим запроса в результат", async () => {
    const stub = stubClient([
      { content: "ответ", completionTokens: 120, reasoningTokens: 90, totalTokens: 300, finishReason: "stop" },
    ]);

    const result = await ask(stub.client, "модель", [], "вопрос", withOptions({ temperature: 0.7, stopMarker: "@@" }));

    expect(result).toMatchObject({
      answer: "ответ",
      format: "text",
      completionTokens: 120,
      reasoningTokens: 90,
      totalTokens: 300,
      finishReason: "stop",
      stopMarker: "@@",
      temperature: 0.7,
      thinkingEnabled: true,
    });
  });

  it("пустой content у reasoning-модели приходит без исключения", async () => {
    const stub = stubClient([{ content: null, finishReason: "length" }]);

    const result = await ask(stub.client, "модель", [], "вопрос", RAW_OPTIONS);

    expect(result.answer).toBe("");
    expect(result.finishReason).toBe("length");
  });

  it("ответ без choices и usage не роняет разбор", async () => {
    const stub = stubClient([{ bare: true }]);

    const result = await ask(stub.client, "модель", [], "вопрос", RAW_OPTIONS);

    expect(result).toMatchObject({ answer: "", totalTokens: 0, reasoningTokens: 0, finishReason: "неизвестно" });
  });

  it("ответ проверяется валидатором выбранного формата", async () => {
    const stub = stubClient([{ content: "не json" }]);

    const result = await ask(stub.client, "модель", [], "вопрос", withOptions({ format: "json" }));

    expect(result.validation).toEqual({ ok: false, reason: "не разбирается как JSON" });
  });
});
