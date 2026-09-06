import type { AskResult } from "./ask.ts";
import { SWEEP_MODELS } from "./models.ts";
import { SWEEP_TEMPERATURES } from "./options.ts";
import type { SolveResult } from "./solve.ts";
import { STRATEGIES, STRATEGY_NAMES, type StrategyName } from "./strategies.ts";

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

export function render(result: AskResult): string {
  return result.answer.length > 0 ? result.answer : "(пустой ответ)";
}

export function fail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeExpect(expect: string[] | null): string {
  return expect === null ? "не задан, сверяем глазами" : expect.join(" | ");
}

/** Первая колонка влево, числовые — вправо. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((_, column) => Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)));

  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)))
        .join("  "),
    )
    .join("\n");
}

/** Пустой ответ у reasoning-модели: рассуждение либо исчерпало лимит, либо задело стоп-секвенцию. */
export function diagnose(result: AskResult): string {
  if (result.answer.length > 0) return "";

  if (result.finishReason === "length") {
    return "\n  Лимит --max-tokens кончился на рассуждении модели, до ответа очередь не дошла. Подними лимит.";
  }

  if (result.stopMarker !== null) {
    return `\n  Похоже, ${result.stopMarker} встретилась в рассуждении модели и оборвала генерацию. Помогает --no-stop.`;
  }

  return "";
}

/** DeepSeek игнорирует temperature, пока включён thinking mode — рассуждение в ответе выдаёт это. */
export function temperatureNote(result: AskResult): string {
  if (result.temperature === null || result.reasoningTokens === 0) return "";

  return result.thinkingEnabled
    ? "\n  --temperature не подействовала: thinking mode включён и DeepSeek её игнорирует. Добавь --thinking=off."
    : "\n  --temperature могла не подействовать: thinking mode выключен флагом, но модель всё равно рассуждала.";
}

/** У meta сбой случается на первом вызове, и по итоговому ответу его не видно. */
function preparationNote(result: SolveResult): string {
  if (result.preparation === null || result.preparation.finishReason !== "length") return "";

  return "\n  Первый вызов оборвался по лимиту: промпт для решения получился неполным.";
}

function verdict(result: SolveResult): string {
  if (!result.measured) return "";
  if (result.finalValue === null) return ", строки FINAL нет";

  return `, итог ${result.hit ? "✓" : "✗"} (${result.finalValue})`;
}

export function metrics(result: SolveResult): string {
  const { final } = result;

  const format =
    final.format === "text"
      ? "формат не задан"
      : final.validation.ok
        ? "формат ✓"
        : `формат ✗ (${final.validation.reason})`;

  const spent =
    final.reasoningTokens > 0
      ? `${final.completionTokens}, из них рассуждение ${final.reasoningTokens}`
      : `${final.completionTokens}`;

  const cost =
    result.preparation === null
      ? `токенов ${result.totalTokens} (ответ ${spent})`
      : `токенов ${result.totalTokens} за два вызова (ответ ${spent})`;

  const line =
    `— ${cost}, символов ${final.answer.length}, finish_reason: ${final.finishReason}, ` +
    `${format}${verdict(result)}, ${seconds(result.elapsedMs)}`;

  return `${line}${diagnose(final)}${temperatureNote(final)}${preparationNote(result)}`;
}

export interface StrategyTally {
  runs: number;
  /** Прогоны, где итог удалось извлечь: только они идут в знаменатель доли попаданий. */
  measured: number;
  hits: number;
  unmeasured: number;
  failures: number;
  tokens: number;
  ms: number;
}

/**
 * Счётчики одной температуры. Знаменатель здесь даёт извлечённый итог, а не заданный эталон:
 * контракт FINAL включён и без --expect, и прогон без строки — не ещё один вариант ответа.
 */
export interface TemperatureTally {
  runs: number;
  /** Прогоны со строкой FINAL: знаменатель и разнообразия, и точности. */
  extracted: number;
  hits: number;
  failures: number;
  tokens: number;
  ms: number;
  /** Нормализованные итоги: размер множества и есть разнообразие. */
  answers: Set<string>;
}

/**
 * Счётчики одного уровня. runs — прогоны с непустым ответом: сбой и пустой content тоже
 * оплачены, но в среднюю цену ответа не идут. attempts — знаменатель долей, отдельно от runs.
 */
export interface ModelTally {
  attempts: number;
  runs: number;
  /** Вызов прошёл, но content пустой: расход есть, ответа нет. */
  empty: number;
  extracted: number;
  hits: number;
  failures: number;
  tokens: number;
  reasoning: number;
  ms: number;
}

export function newStrategyTally(): StrategyTally {
  return { runs: 0, measured: 0, hits: 0, unmeasured: 0, failures: 0, tokens: 0, ms: 0 };
}

export function newTemperatureTally(): TemperatureTally {
  return { runs: 0, extracted: 0, hits: 0, failures: 0, tokens: 0, ms: 0, answers: new Set<string>() };
}

export function newModelTally(): ModelTally {
  return { attempts: 0, runs: 0, empty: 0, extracted: 0, hits: 0, failures: 0, tokens: 0, reasoning: 0, ms: 0 };
}

function footnote(label: string, notes: string[]): string[] {
  return notes.length > 0 ? [`  ${label}: ${notes.join(", ")}`] : [];
}

export function strategyTable(tally: Map<StrategyName, StrategyTally>, measured: boolean): string {
  const header = measured ? ["способ", "попаданий", "токенов", "время"] : ["способ", "токенов", "время"];

  const rows = STRATEGY_NAMES.map((name) => {
    const stats = tally.get(name)!;
    const cells = [STRATEGIES[name].title, `${stats.tokens}`, seconds(stats.ms)];

    return measured ? [cells[0]!, `${stats.hits}/${stats.measured}`, cells[1]!, cells[2]!] : cells;
  });

  return table(header, rows);
}

/** Промах и неизмеренное — разные вещи, в долю попаданий их мешать нельзя. */
export function strategyFootnotes(tally: Map<StrategyName, StrategyTally>): string[] {
  return STRATEGY_NAMES.flatMap((name) => {
    const stats = tally.get(name)!;
    const notes: string[] = [];

    if (stats.failures > 0) notes.push(`сбоев ${stats.failures}`);
    if (stats.unmeasured > 0) notes.push(`без строки FINAL ${stats.unmeasured}`);

    return footnote(STRATEGIES[name].title, notes);
  });
}

export function temperatureTable(tally: Map<number, TemperatureTally>, measured: boolean): string {
  const header = measured
    ? ["температура", "уникальных", "попаданий", "токенов", "время"]
    : ["температура", "уникальных", "токенов", "время"];

  const rows = SWEEP_TEMPERATURES.map((temperature) => {
    const stats = tally.get(temperature)!;
    const cells = [`${temperature}`, `${stats.answers.size}/${stats.extracted}`, `${stats.tokens}`, seconds(stats.ms)];

    return measured ? [cells[0]!, cells[1]!, `${stats.hits}/${stats.extracted}`, cells[2]!, cells[3]!] : cells;
  });

  return table(header, rows);
}

export function temperatureFootnotes(tally: Map<number, TemperatureTally>): string[] {
  return SWEEP_TEMPERATURES.flatMap((temperature) => {
    const stats = tally.get(temperature)!;
    const notes: string[] = [];

    if (stats.failures > 0) notes.push(`сбоев ${stats.failures}`);
    if (stats.runs - stats.extracted > 0) notes.push(`без строки FINAL ${stats.runs - stats.extracted}`);

    return footnote(`temperature ${temperature}`, notes);
  });
}

/** "—" вместо 0: уровень без единого ответа не должен выглядеть самым дешёвым и быстрым. */
function average(sum: number, runs: number): string {
  return runs > 0 ? `${Math.round(sum / runs)}` : "—";
}

/**
 * Рядом с долей попаданий обязателен знаменатель от запланированных попыток: уровень, ответивший
 * один раз из пяти и попавший в цель, показал бы 1/1 и обошёл бы уровень с четырьмя верными из пяти.
 */
export function modelTable(tally: Map<string, ModelTally>, measured: boolean): string {
  const header = measured
    ? ["уровень", "попаданий", "сравнимых", "токенов", "рассуждение", "время"]
    : ["уровень", "ответов", "токенов", "рассуждение", "время"];

  const rows = SWEEP_MODELS.map((tier) => {
    const stats = tally.get(tier.label)!;
    const tokens = average(stats.tokens, stats.runs);
    const reasoning = average(stats.reasoning, stats.runs);
    const time = stats.runs > 0 ? seconds(stats.ms / stats.runs) : "—";

    if (measured) {
      return [
        tier.label,
        `${stats.hits}/${stats.extracted}`,
        `${stats.extracted}/${stats.attempts}`,
        tokens,
        reasoning,
        time,
      ];
    }

    return [tier.label, `${stats.runs}/${stats.attempts}`, tokens, reasoning, time];
  });

  return table(header, rows);
}

/** Три разные потери: запрос не прошёл, ответ пришёл пустым, ответ есть — но без строки FINAL. */
export function modelFootnotes(tally: Map<string, ModelTally>, measured: boolean): string[] {
  return SWEEP_MODELS.flatMap((tier) => {
    const stats = tally.get(tier.label)!;
    const notes: string[] = [];

    if (stats.failures > 0) notes.push(`сбоев ${stats.failures}`);
    if (stats.empty > 0) notes.push(`пустых ответов ${stats.empty}`);
    if (measured && stats.runs - stats.extracted > 0) notes.push(`без строки FINAL ${stats.runs - stats.extracted}`);

    return footnote(tier.label, notes);
  });
}
