import { describe, expect, it } from "vitest";
import { SWEEP_MODELS } from "../src/models.ts";
import { SWEEP_TEMPERATURES } from "../src/options.ts";
import {
  describeExpect,
  diagnose,
  fail,
  type ModelTally,
  metrics,
  modelFootnotes,
  modelTable,
  newModelTally,
  newStrategyTally,
  newTemperatureTally,
  render,
  type StrategyTally,
  seconds,
  strategyFootnotes,
  strategyTable,
  type TemperatureTally,
  table,
  temperatureFootnotes,
  temperatureNote,
  temperatureTable,
} from "../src/report.ts";
import { STRATEGY_NAMES, type StrategyName } from "../src/strategies.ts";
import { askResult, solveResult } from "./support/fixtures.ts";

function strategyTally(
  entries: Partial<Record<StrategyName, Partial<StrategyTally>>>,
): Map<StrategyName, StrategyTally> {
  return new Map(STRATEGY_NAMES.map((name) => [name, { ...newStrategyTally(), ...entries[name] }]));
}

function temperatureTally(entries: Record<number, Partial<TemperatureTally>>): Map<number, TemperatureTally> {
  return new Map(SWEEP_TEMPERATURES.map((value) => [value, { ...newTemperatureTally(), ...entries[value] }]));
}

function modelTally(entries: Record<string, Partial<ModelTally>>): Map<string, ModelTally> {
  return new Map(SWEEP_MODELS.map((tier) => [tier.label, { ...newModelTally(), ...entries[tier.label] }]));
}

/** Ячейки строки: колонки разделены двумя пробелами и добиты до ширины. */
function cells(line: string): string[] {
  return line.trim().split(/\s{2,}/);
}

describe("мелкие форматтеры", () => {
  it("время печатается секундами с одним знаком", () => {
    expect(seconds(1500)).toBe("1.5 с");
  });

  it("пустой ответ виден как пустой, а не как пропуск строки", () => {
    expect(render(askResult({ answer: "" }))).toBe("(пустой ответ)");
    expect(render(askResult({ answer: "ответ" }))).toBe("ответ");
  });

  it("сбой без Error печатается как есть", () => {
    expect(fail(new Error("429"))).toBe("429");
    expect(fail("строкой")).toBe("строкой");
  });

  it("незаданный эталон называется словами", () => {
    expect(describeExpect(null)).toBe("не задан, сверяем глазами");
    expect(describeExpect(["1/2", "50%"])).toBe("1/2 | 50%");
  });
});

describe("table", () => {
  it("первая колонка влево, числовые вправо", () => {
    const rendered = table(
      ["способ", "токенов"],
      [
        ["прямой", "1200"],
        ["меты", "30"],
      ],
    );

    expect(rendered.split("\n")).toEqual(["способ  токенов", "прямой     1200", "меты         30"]);
  });
});

describe("diagnose", () => {
  it("непустой ответ не диагностируется", () => {
    expect(diagnose(askResult({ answer: "ответ", finishReason: "length" }))).toBe("");
  });

  it("пустой ответ по лимиту указывает на --max-tokens", () => {
    expect(diagnose(askResult({ answer: "", finishReason: "length" }))).toContain("--max-tokens");
  });

  it("пустой ответ при заданной стоп-секвенции указывает на неё", () => {
    const note = diagnose(askResult({ answer: "", finishReason: "stop", stopMarker: "<<<END>>>" }));

    expect(note).toContain("<<<END>>>");
    expect(note).toContain("--no-stop");
  });

  it("пустой ответ без обеих причин молчит: подсказка указала бы не туда", () => {
    expect(diagnose(askResult({ answer: "", finishReason: "stop", stopMarker: null }))).toBe("");
  });
});

describe("temperatureNote", () => {
  it("без заданной температуры молчит", () => {
    expect(temperatureNote(askResult({ temperature: null, reasoningTokens: 100 }))).toBe("");
  });

  it("без рассуждения в ответе молчит: доказательства игнорирования нет", () => {
    expect(temperatureNote(askResult({ temperature: 0.7, reasoningTokens: 0 }))).toBe("");
  });

  it("при включённом thinking утверждает, что температура не подействовала", () => {
    const note = temperatureNote(askResult({ temperature: 0.7, reasoningTokens: 100, thinkingEnabled: true }));

    expect(note).toContain("не подействовала");
    expect(note).toContain("--thinking=off");
  });

  it("при выключенном thinking формулировка мягче: модель всё равно рассуждала", () => {
    const note = temperatureNote(askResult({ temperature: 0.7, reasoningTokens: 100, thinkingEnabled: false }));

    expect(note).toContain("могла не подействовать");
  });
});

describe("metrics", () => {
  it("свободный текст не проверяется на формат", () => {
    const line = metrics(solveResult({ final: askResult({ answer: "ответ", completionTokens: 10, totalTokens: 30 }) }));

    expect(line).toBe("— токенов 30 (ответ 10), символов 5, finish_reason: stop, формат не задан, 1.5 с");
  });

  it("нарушение формата называет причину", () => {
    const final = askResult({ format: "json", validation: { ok: false, reason: "нет поля summary" } });

    expect(metrics(solveResult({ final }))).toContain("формат ✗ (нет поля summary)");
  });

  it("выдержанный формат отмечается галочкой", () => {
    expect(metrics(solveResult({ final: askResult({ format: "json" }) }))).toContain("формат ✓");
  });

  it("рассуждение выделяется из токенов ответа", () => {
    const final = askResult({ completionTokens: 120, reasoningTokens: 90 });

    expect(metrics(solveResult({ final }))).toContain("ответ 120, из них рассуждение 90");
  });

  it("у meta цена помечена как за два вызова", () => {
    const result = solveResult({ preparation: askResult(), totalTokens: 300 });

    expect(metrics(result)).toContain("токенов 300 за два вызова");
  });

  it("обрыв первого вызова meta виден отдельной строкой: по итоговому ответу его не видно", () => {
    const result = solveResult({ preparation: askResult({ finishReason: "length" }) });

    expect(metrics(result)).toContain("Первый вызов оборвался по лимиту");
  });

  it("без эталона вердикта нет", () => {
    expect(metrics(solveResult({ measured: false, finalValue: "Даша" }))).not.toContain("итог");
  });

  it("попадание и промах различаются знаком, значение печатается рядом", () => {
    expect(metrics(solveResult({ measured: true, finalValue: "Даша", hit: true }))).toContain("итог ✓ (Даша)");
    expect(metrics(solveResult({ measured: true, finalValue: "Аня", hit: false }))).toContain("итог ✗ (Аня)");
  });

  it("отсутствие строки FINAL — не промах, а отдельная формулировка", () => {
    const line = metrics(solveResult({ measured: true, finalValue: null, hit: null }));

    expect(line).toContain("строки FINAL нет");
    expect(line).not.toContain("✗");
  });
});

describe("сводка способов", () => {
  it("без эталона колонки попаданий нет", () => {
    const rendered = strategyTable(strategyTally({ direct: { tokens: 1200, ms: 3400 } }), false);

    expect(cells(rendered.split("\n")[0]!)).toEqual(["способ", "токенов", "время"]);
    expect(cells(rendered.split("\n")[1]!)).toEqual(["прямой ответ", "1200", "3.4 с"]);
  });

  it("с эталоном знаменатель — прогоны с извлечённым итогом", () => {
    const tally = strategyTally({ steps: { runs: 3, measured: 2, hits: 1, unmeasured: 1, tokens: 900, ms: 1000 } });
    const row = strategyTable(tally, true).split("\n")[2]!;

    expect(cells(row)).toEqual(["пошаговое рассуждение", "1/2", "900", "1.0 с"]);
  });

  it("сбои и прогоны без FINAL разведены в сноске", () => {
    const tally = strategyTally({ meta: { failures: 2, unmeasured: 1 }, experts: { failures: 1 } });

    expect(strategyFootnotes(tally)).toEqual([
      "  промпт от самой модели: сбоев 2, без строки FINAL 1",
      "  группа экспертов: сбоев 1",
    ]);
  });

  it("у способа без потерь сноски нет", () => {
    expect(strategyFootnotes(strategyTally({ direct: { runs: 3, measured: 3, hits: 3 } }))).toEqual([]);
  });
});

describe("сводка температур", () => {
  it("разнообразие считается от извлечённых итогов, а не от прогонов", () => {
    const tally = temperatureTally({
      0: { runs: 3, extracted: 2, hits: 2, tokens: 600, ms: 2000, answers: new Set(["даша"]) },
    });

    expect(cells(temperatureTable(tally, true).split("\n")[1]!)).toEqual(["0", "1/2", "2/2", "600", "2.0 с"]);
  });

  it("без эталона колонки попаданий нет, разнообразие остаётся", () => {
    const header = temperatureTable(temperatureTally({}), false).split("\n")[0]!;

    expect(cells(header)).toEqual(["температура", "уникальных", "токенов", "время"]);
  });

  it("прогоны без строки FINAL считаются в сноске, а не в знаменателе", () => {
    const tally = temperatureTally({ 1.2: { runs: 5, extracted: 3, failures: 1 } });

    expect(temperatureFootnotes(tally)).toEqual(["  temperature 1.2: сбоев 1, без строки FINAL 2"]);
  });
});

describe("сводка уровней модели", () => {
  const labels = SWEEP_MODELS.map((tier) => tier.label);

  it("средние считаются на полученный ответ, а не на попытку", () => {
    const tally = modelTally({
      [labels[1]!]: { attempts: 2, runs: 2, extracted: 2, hits: 2, tokens: 600, reasoning: 200, ms: 4000 },
    });

    expect(cells(modelTable(tally, true).split("\n")[2]!)).toEqual([labels[1]!, "2/2", "2/2", "300", "100", "2.0 с"]);
  });

  it("уровень без единого ответа печатает «—», а не 0: ноль читался бы как самый дешёвый", () => {
    const tally = modelTally({ [labels[0]!]: { attempts: 3, failures: 3 } });

    expect(cells(modelTable(tally, true).split("\n")[1]!)).toEqual([labels[0]!, "0/0", "0/3", "—", "—", "—"]);
  });

  it("рядом с долей попаданий стоит знаменатель от запланированных попыток", () => {
    const tally = modelTally({ [labels[0]!]: { attempts: 5, runs: 1, extracted: 1, hits: 1, tokens: 100, ms: 1000 } });
    const [header, row] = modelTable(tally, true).split("\n");

    expect(cells(header!)).toEqual(["уровень", "попаданий", "сравнимых", "токенов", "рассуждение", "время"]);
    expect(cells(row!).slice(0, 3)).toEqual([labels[0]!, "1/1", "1/5"]);
  });

  it("без эталона колонка считает полученные ответы от попыток", () => {
    const tally = modelTally({ [labels[0]!]: { attempts: 5, runs: 4, tokens: 400, ms: 4000 } });
    const [header, row] = modelTable(tally, false).split("\n");

    expect(cells(header!)).toEqual(["уровень", "ответов", "токенов", "рассуждение", "время"]);
    expect(cells(row!).slice(0, 2)).toEqual([labels[0]!, "4/5"]);
  });

  it("три вида потерь разведены в сноске", () => {
    const tally = modelTally({ [labels[0]!]: { attempts: 6, runs: 3, extracted: 1, empty: 1, failures: 2 } });

    expect(modelFootnotes(tally, true)).toEqual([`  ${labels[0]}: сбоев 2, пустых ответов 1, без строки FINAL 2`]);
  });

  it("без эталона строка FINAL не считается потерей: её не запрашивали", () => {
    const tally = modelTally({ [labels[0]!]: { attempts: 3, runs: 3, extracted: 0, empty: 1 } });

    expect(modelFootnotes(tally, false)).toEqual([`  ${labels[0]}: пустых ответов 1`]);
  });
});
