import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import OpenAI from "openai";
import type { AskResult } from "./ask.js";
import { answerKey, solve, StrategyError, type SolveResult } from "./solve.js";
import { STRATEGIES, STRATEGY_NAMES, type StrategyName } from "./strategies.js";
import {
  applySlashCommand,
  describeOptions,
  HELP,
  OptionsError,
  parseCli,
  RAW_OPTIONS,
  SWEEP_TEMPERATURES,
  type Cli,
} from "./options.js";

let cli: Cli;

try {
  cli = parseCli(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof OptionsError)) throw error;
  console.error(`${error.message}\n\n${HELP}`);
  process.exit(1);
}

if (cli.help) {
  console.log(HELP);
  process.exit(0);
}

const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  console.error("Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.");
  process.exit(1);
}

const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

// DeepSeek отдаёт OpenAI-совместимый API — хватает подмены baseURL в официальном SDK.
const client = new OpenAI({
  apiKey,
  baseURL: "https://api.deepseek.com",
});

const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
let options = cli.options;
let totalTokens = 0;

for (const warning of cli.warnings) console.warn(`! ${warning}`);

/** Пустой ответ у reasoning-модели: рассуждение либо исчерпало лимит, либо задело стоп-секвенцию. */
function diagnose(result: AskResult): string {
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
function temperatureNote(result: AskResult): string {
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

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

function verdict(result: SolveResult): string {
  if (!result.measured) return "";
  if (result.finalValue === null) return ", строки FINAL нет";

  return `, итог ${result.hit ? "✓" : "✗"} (${result.finalValue})`;
}

function metrics(result: SolveResult): string {
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

function render(result: AskResult): string {
  return result.answer.length > 0 ? result.answer : "(пустой ответ)";
}

function fail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Первая колонка влево, числовые — вправо. */
function table(header: string[], rows: string[][]): string {
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)),
  );

  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)))
        .join("  "),
    )
    .join("\n");
}

interface Tally {
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
interface TemperatureTally {
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

if (cli.allStrategies) {
  console.log(`\nЗадача: ${cli.prompt}`);
  console.log(`Модель: ${model}`);
  console.log(`Режим: ${describeOptions(options)}`);
  console.log(`Верный ответ: ${cli.expect === null ? "не задан, сверяем глазами" : cli.expect.join(" | ")}\n`);

  const tally = new Map<StrategyName, Tally>(
    STRATEGY_NAMES.map((name) => [
      name,
      { runs: 0, measured: 0, hits: 0, unmeasured: 0, failures: 0, tokens: 0, ms: 0 },
    ]),
  );

  for (let run = 1; run <= cli.repeat; run += 1) {
    if (cli.repeat > 1) console.log(`═══ прогон ${run}/${cli.repeat} ══════════════════════════════\n`);

    // Последовательно, а не Promise.all: параллельные вызовы делят один rate limit и время
    // перестаёт что-либо значить, а сбой одного способа не должен ронять уже оплаченные ответы.
    for (const strategy of STRATEGY_NAMES) {
      const stats = tally.get(strategy)!;

      console.log(`─── ${STRATEGIES[strategy].title} (${strategy}) ───────────────────`);

      try {
        // Прогоны независимы: history не копится, иначе способы видели бы ответы друг друга.
        const result = await solve(client, model, [], cli.prompt, { ...options, strategy }, cli.expect);

        if (result.generatedPrompt !== null) {
          console.log(`\nпромпт, сочинённый моделью:\n${result.generatedPrompt}\n\nответ по этому промпту:`);
        }

        console.log(`\n${render(result.final)}`);
        console.log(`${metrics(result)}\n`);

        stats.runs += 1;
        stats.tokens += result.totalTokens;
        stats.ms += result.elapsedMs;
        totalTokens += result.totalTokens;

        if (result.measured && result.finalValue === null) stats.unmeasured += 1;
        if (result.measured && result.finalValue !== null) stats.measured += 1;
        if (result.hit === true) stats.hits += 1;
      } catch (error) {
        console.error(`\n— ошибка: ${fail(error)}\n`);
        stats.failures += 1;

        // Первый вызов meta оплачен, даже когда упал второй, — иначе цена способа занижена.
        if (error instanceof StrategyError) {
          stats.tokens += error.spentTokens;
          stats.ms += error.elapsedMs;
          totalTokens += error.spentTokens;
        }
      }
    }
  }

  const measured = cli.expect !== null;
  const header = measured ? ["способ", "попаданий", "токенов", "время"] : ["способ", "токенов", "время"];

  const rows = STRATEGY_NAMES.map((name) => {
    const stats = tally.get(name)!;
    const cells = [STRATEGIES[name].title, `${stats.tokens}`, seconds(stats.ms)];

    return measured ? [cells[0]!, `${stats.hits}/${stats.measured}`, cells[1]!, cells[2]!] : cells;
  });

  console.log("═══ ИТОГО ══════════════════════════════════════════\n");
  console.log(table(header, rows));

  // Промах и неизмеренное — разные вещи, в долю попаданий их мешать нельзя.
  for (const name of STRATEGY_NAMES) {
    const stats = tally.get(name)!;
    const notes: string[] = [];

    if (stats.failures > 0) notes.push(`сбоев ${stats.failures}`);
    if (stats.unmeasured > 0) notes.push(`без строки FINAL ${stats.unmeasured}`);
    if (notes.length > 0) console.log(`  ${STRATEGIES[name].title}: ${notes.join(", ")}`);
  }

  console.log(`\nвсего потрачено токенов: ${totalTokens}`);
} else if (cli.allTemperatures) {
  console.log(`\nЗапрос: ${cli.prompt}`);
  console.log(`Модель: ${model}`);
  console.log(`Режим: ${describeOptions(options)}`);
  console.log(`Температуры: ${SWEEP_TEMPERATURES.join(", ")}`);
  console.log(`Верный ответ: ${cli.expect === null ? "не задан, сверяем глазами" : cli.expect.join(" | ")}\n`);

  const tally = new Map<number, TemperatureTally>(
    SWEEP_TEMPERATURES.map((temperature) => [
      temperature,
      { runs: 0, extracted: 0, hits: 0, failures: 0, tokens: 0, ms: 0, answers: new Set<string>() },
    ]),
  );

  // Температура внешним циклом: ответы одной настройки идут подряд, иначе разброс не читается.
  for (const temperature of SWEEP_TEMPERATURES) {
    const stats = tally.get(temperature)!;

    console.log(`─── temperature ${temperature} ───────────────────`);

    // Последовательно, как и у --strategy=all: параллельные вызовы делят один rate limit.
    for (let run = 1; run <= cli.repeat; run += 1) {
      try {
        // Прогоны независимы: history не копится, иначе модель копировала бы прошлый ответ.
        const result = await solve(client, model, [], cli.prompt, { ...options, temperature }, cli.expect);

        if (cli.repeat > 1) console.log(`\n── прогон ${run}/${cli.repeat} ─────────────────`);

        if (result.generatedPrompt !== null) {
          console.log(`\nпромпт, сочинённый моделью:\n${result.generatedPrompt}\n\nответ по этому промпту:`);
        }

        console.log(`\n${render(result.final)}`);
        console.log(`${metrics(result)}\n`);

        stats.runs += 1;
        stats.tokens += result.totalTokens;
        stats.ms += result.elapsedMs;
        totalTokens += result.totalTokens;

        if (result.finalValue !== null) {
          stats.extracted += 1;
          stats.answers.add(answerKey(result.finalValue));
        }

        if (result.hit === true) stats.hits += 1;
      } catch (error) {
        console.error(`\n— ошибка: ${fail(error)}\n`);
        stats.failures += 1;

        if (error instanceof StrategyError) {
          stats.tokens += error.spentTokens;
          stats.ms += error.elapsedMs;
          totalTokens += error.spentTokens;
        }
      }
    }
  }

  const measured = cli.expect !== null;
  const header = measured
    ? ["температура", "уникальных", "попаданий", "токенов", "время"]
    : ["температура", "уникальных", "токенов", "время"];

  const rows = SWEEP_TEMPERATURES.map((temperature) => {
    const stats = tally.get(temperature)!;
    const cells = [
      `${temperature}`,
      `${stats.answers.size}/${stats.extracted}`,
      `${stats.tokens}`,
      seconds(stats.ms),
    ];

    return measured ? [cells[0]!, cells[1]!, `${stats.hits}/${stats.extracted}`, cells[2]!, cells[3]!] : cells;
  });

  console.log("═══ ИТОГО ══════════════════════════════════════════\n");
  console.log(table(header, rows));

  for (const temperature of SWEEP_TEMPERATURES) {
    const stats = tally.get(temperature)!;
    const missing = stats.runs - stats.extracted;
    const notes: string[] = [];

    if (stats.failures > 0) notes.push(`сбоев ${stats.failures}`);
    if (missing > 0) notes.push(`без строки FINAL ${missing}`);
    if (notes.length > 0) console.log(`  temperature ${temperature}: ${notes.join(", ")}`);
  }

  console.log(`\nвсего потрачено токенов: ${totalTokens}`);
} else if (cli.compare) {
  console.log(`\nЗапрос: ${cli.prompt}`);
  console.log(`Модель: ${model}\n`);

  try {
    const [raw, limited] = await Promise.all([
      solve(client, model, [], cli.prompt, { ...RAW_OPTIONS, finalLine: options.finalLine }, cli.expect),
      solve(client, model, [], cli.prompt, options, cli.expect),
    ]);

    console.log("─── БЕЗ ОГРАНИЧЕНИЙ ───────────────────────────────");
    console.log(`режим: ${describeOptions(RAW_OPTIONS)}\n`);
    console.log(render(raw.final));
    console.log(`\n${metrics(raw)}\n`);

    console.log("─── С ОГРАНИЧЕНИЯМИ ───────────────────────────────");
    console.log(`режим: ${describeOptions(options)}\n`);
    console.log(render(limited.final));
    console.log(`\n${metrics(limited)}`);
  } catch (error) {
    console.error("Запрос не удался:", fail(error));
    process.exit(1);
  }
} else if (cli.prompt) {
  console.log(`\nЗапрос: ${cli.prompt}`);
  console.log(`Модель: ${model}`);
  console.log(`Режим: ${describeOptions(options)}\n`);

  let valid = 0;
  let hits = 0;

  try {
    for (let run = 1; run <= cli.repeat; run += 1) {
      // Прогоны независимы: history не копится, иначе модель копировала бы прошлый ответ.
      const result = await solve(client, model, [], cli.prompt, options, cli.expect);

      totalTokens += result.totalTokens;
      if (result.final.validation.ok) valid += 1;
      if (result.hit === true) hits += 1;

      if (cli.repeat > 1) console.log(`── прогон ${run}/${cli.repeat} ─────────────────`);

      if (result.generatedPrompt !== null) {
        console.log(`промпт, сочинённый моделью:\n${result.generatedPrompt}\n\nответ по этому промпту:`);
      }

      console.log(render(result.final));
      console.log(`${metrics(result)}\n`);
    }
  } catch (error) {
    console.error("Запрос не удался:", fail(error));
    process.exit(1);
  }

  if (cli.repeat > 1) {
    // При text валидатор всегда доволен — доля валидных ответов ничего не измеряет.
    const held = options.format === "text" ? "" : `Формат выдержан: ${valid}/${cli.repeat}, `;
    const accuracy = cli.expect === null ? "" : `Верных итогов: ${hits}/${cli.repeat}, `;
    console.log(`${accuracy}${held}потрачено токенов: ${totalTokens}`);
  }
} else {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Без этого Ctrl+C во время ввода не закрывает интерфейс, и процесс висит.
  rl.on("SIGINT", () => rl.close());

  console.log(`Модель: ${model}. Выход — /exit, Ctrl+C или Ctrl+D. Команды — /help.`);
  console.log(`Режим: ${describeOptions(options)}\n`);
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const question = line.trim();

    if (!question) {
      rl.prompt();
      continue;
    }

    if (question.toLowerCase() === "/exit") break;

    const command = applySlashCommand(question, options);

    if (command) {
      options = command.options;
      console.log(`\n${command.output}\n`);
      rl.prompt();
      continue;
    }

    try {
      // Эталон сюда не передаётся: --expect в диалоге не действует, и строка FINAL не запрашивалась.
      const result = await solve(client, model, history, question, options, null);

      // Реплики дописываются только после успеха и непустого ответа — вопроса без ответа
      // в history не остаётся, иначе следующий запрос уходит с фиктивной репликой ассистента.
      // В history идёт исходный вопрос, а не сгенерированный промпт: диалог должен читаться.
      if (result.final.answer.length > 0) {
        history.push(
          { role: "user", content: question },
          { role: "assistant", content: result.final.answer },
        );
      }

      totalTokens += result.totalTokens;

      if (result.generatedPrompt !== null) {
        console.log(`\nпромпт, сочинённый моделью:\n${result.generatedPrompt}\n\nответ по этому промпту:`);
      }

      console.log(`\n${render(result.final)}`);
      console.log(`${metrics(result)}\n`);
    } catch (error) {
      console.error(`\nЗапрос не удался: ${fail(error)}\n`);
    }

    rl.prompt();
  }

  rl.close();
  console.log(`\n— израсходовано токенов за сессию: ${totalTokens}`);
}
