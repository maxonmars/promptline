import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { RAW_OPTIONS, type ResponseOptions } from "../src/options.ts";
import { answerKey, extractFinal, matchesExpected, StrategyError, solve } from "../src/solve.ts";
import { FINAL_CONTRACT, META_INSTRUCTION } from "../src/strategies.ts";
import { stubClient, systemOf } from "./support/stub-client.ts";

function withOptions(overrides: Partial<ResponseOptions> = {}): ResponseOptions {
  return { ...RAW_OPTIONS, ...overrides };
}

describe("extractFinal", () => {
  it("возвращает null, если строки FINAL нет", () => {
    expect(extractFinal("Просто ответ без итога.")).toBeNull();
  });

  it("извлекает значение единственной строки FINAL", () => {
    expect(extractFinal("Рассуждение...\nFINAL: 42")).toBe("42");
  });

  it("берёт последнее совпадение, если FINAL встречается несколько раз", () => {
    const answer = "FINAL: Аня\nЕщё рассуждение...\nFINAL: Даша";
    expect(extractFinal(answer)).toBe("Даша");
  });

  it("обрезает пробелы вокруг значения", () => {
    expect(extractFinal("  FINAL:   42  ")).toBe("42");
  });

  it("маркер в середине строки итогом не считается: контракт требует его первой позиции", () => {
    expect(extractFinal("Итого FINAL: Даша")).toBeNull();
  });

  it("строка без значения итогом не считается", () => {
    expect(extractFinal("FINAL:")).toBeNull();
  });
});

describe("matchesExpected", () => {
  it("крайняя пунктуация и регистр значения не меняют", () => {
    expect(matchesExpected("Даша.", ["даша"])).toBe(true);
    expect(matchesExpected("«Даша»", ["Даша"])).toBe(true);
  });

  it("сверяет итог целиком: «не Даша» содержит «Даша», но ответом не является", () => {
    expect(matchesExpected("не Даша", ["Даша"])).toBe(false);
  });

  it("минус и скобки не обрезаются: это разные ответы", () => {
    expect(matchesExpected("-1", ["1"])).toBe(false);
    expect(matchesExpected("(0,1)", ["[0,1]"])).toBe(false);
  });

  it("пробелы внутри значения схлопываются", () => {
    expect(matchesExpected("два   слова", ["два слова"])).toBe(true);
  });

  it("засчитывает любой из вариантов эталона", () => {
    expect(matchesExpected("50%", ["1/2", "50%"])).toBe(true);
  });
});

describe("answerKey", () => {
  it("считает «Кот.» и «кот» одним ответом", () => {
    expect(answerKey("Кот.")).toBe(answerKey("кот"));
  });
});

describe("solve: один вызов", () => {
  it("прямой способ делает единственный вызов и не сочиняет промпт", async () => {
    const stub = stubClient([{ content: "ответ", totalTokens: 300 }]);

    const result = await solve(stub.client, "модель", [], "вопрос", RAW_OPTIONS, null);

    expect(stub.calls).toHaveLength(1);
    expect(result).toMatchObject({
      strategy: "direct",
      preparation: null,
      generatedPrompt: null,
      totalTokens: 300,
      measured: false,
      hit: null,
    });
  });

  it("без эталона итог извлекается, но точность не измеряется", async () => {
    const stub = stubClient([{ content: "рассуждение\nFINAL: Даша" }]);

    const result = await solve(stub.client, "модель", [], "вопрос", RAW_OPTIONS, null);

    expect(result.finalValue).toBe("Даша");
    expect(result.hit).toBeNull();
  });

  it("с эталоном сверяет извлечённый итог", async () => {
    const stub = stubClient([{ content: "FINAL: Даша" }, { content: "FINAL: Аня" }]);

    const hit = await solve(stub.client, "модель", [], "вопрос", RAW_OPTIONS, ["Даша"]);
    const miss = await solve(stub.client, "модель", [], "вопрос", RAW_OPTIONS, ["Даша"]);

    expect(hit.hit).toBe(true);
    expect(miss.hit).toBe(false);
  });

  it("прогон без строки FINAL — не промах, а неизмеренный: hit остаётся null", async () => {
    const stub = stubClient([{ content: "ответ без итога" }]);

    const result = await solve(stub.client, "модель", [], "вопрос", RAW_OPTIONS, ["Даша"]);

    expect(result).toMatchObject({ finalValue: null, measured: true, hit: null });
  });

  it("сбой вызова приходит как StrategyError без потраченных токенов", async () => {
    const stub = stubClient([new Error("429 Too Many Requests")]);

    const error = await solve(stub.client, "модель", [], "вопрос", RAW_OPTIONS, null).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(StrategyError);
    expect(error).toMatchObject({ message: "429 Too Many Requests", spentTokens: 0 });
  });
});

describe("solve: meta", () => {
  const metaOptions = withOptions({ strategy: "meta", maxWords: 60, finalLine: true, maxTokens: 500 });

  it("первый вызов просит промпт, второй решает задачу по нему", async () => {
    const stub = stubClient([
      { content: "  СОЧИНЁННЫЙ ПРОМПТ  ", totalTokens: 100 },
      { content: "FINAL: 42", totalTokens: 200, reasoningTokens: 40 },
    ]);

    const result = await solve(stub.client, "модель", [], "вопрос", metaOptions, null);

    expect(stub.calls).toHaveLength(2);
    expect(systemOf(stub.calls[0]!)).toContain(META_INSTRUCTION);
    expect(systemOf(stub.calls[1]!)).toContain("СОЧИНЁННЫЙ ПРОМПТ");
    expect(result.generatedPrompt).toBe("СОЧИНЁННЫЙ ПРОМПТ");
  });

  it("контракт ответа описывает решение, а не промпт: в первый вызов он не уходит", async () => {
    const stub = stubClient([{ content: "СОЧИНЁННЫЙ ПРОМПТ" }, { content: "ответ" }]);

    await solve(stub.client, "модель", [], "вопрос", metaOptions, null);

    expect(systemOf(stub.calls[0]!)).not.toContain(FINAL_CONTRACT);
    expect(systemOf(stub.calls[0]!)).not.toContain("Уложись в 60 слов");
    expect(systemOf(stub.calls[1]!)).toContain(FINAL_CONTRACT);
    expect(systemOf(stub.calls[1]!)).toContain("Уложись в 60 слов");
  });

  it("лимит токенов остаётся у обоих вызовов: он ограничивает саму генерацию", async () => {
    const stub = stubClient([{ content: "СОЧИНЁННЫЙ ПРОМПТ" }, { content: "ответ" }]);

    await solve(stub.client, "модель", [], "вопрос", metaOptions, null);

    expect(stub.calls.map((call) => call.max_tokens)).toEqual([500, 500]);
  });

  it("пользовательским сообщением обоих вызовов остаётся исходная задача", async () => {
    const stub = stubClient([{ content: "СОЧИНЁННЫЙ ПРОМПТ" }, { content: "ответ" }]);

    await solve(stub.client, "модель", [], "вопрос", metaOptions, null);

    for (const call of stub.calls) expect(call.messages.at(-1)).toEqual({ role: "user", content: "вопрос" });
  });

  it("история уходит в оба вызова: без неё уточняющий вопрос породит промпт без предмета", async () => {
    const stub = stubClient([{ content: "СОЧИНЁННЫЙ ПРОМПТ" }, { content: "ответ" }]);
    const history: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: "прошлый вопрос" }];

    await solve(stub.client, "модель", history, "а если наоборот?", metaOptions, null);

    for (const call of stub.calls) expect(call.messages).toContainEqual({ role: "user", content: "прошлый вопрос" });
  });

  it("цена способа — сумма обоих вызовов", async () => {
    const stub = stubClient([
      { content: "СОЧИНЁННЫЙ ПРОМПТ", totalTokens: 100, reasoningTokens: 10 },
      { content: "ответ", totalTokens: 200, reasoningTokens: 40 },
    ]);

    const result = await solve(stub.client, "модель", [], "вопрос", metaOptions, null);

    expect(result).toMatchObject({ totalTokens: 300, reasoningTokens: 50 });
    expect(result.final.totalTokens).toBe(200);
    expect(result.preparation?.totalTokens).toBe(100);
  });

  it("пустой промпт обрывает способ до второго вызова, но первый уже оплачен", async () => {
    const stub = stubClient([{ content: "", finishReason: "length", totalTokens: 150 }]);

    const error = await solve(stub.client, "модель", [], "вопрос", metaOptions, null).catch(
      (reason: unknown) => reason,
    );

    expect(stub.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(StrategyError);
    expect(error).toMatchObject({ spentTokens: 150 });
    expect((error as StrategyError).message).toContain("finish_reason: length");
  });

  it("сбой второго вызова несёт расход первого: иначе цена способа занижена", async () => {
    const stub = stubClient([{ content: "СОЧИНЁННЫЙ ПРОМПТ", totalTokens: 150 }, new Error("500 Server Error")]);

    const error = await solve(stub.client, "модель", [], "вопрос", metaOptions, null).catch(
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ message: "500 Server Error", spentTokens: 150 });
  });
});
