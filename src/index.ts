import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import OpenAI from "openai";
import { ask, type AskResult } from "./ask.js";
import {
  applySlashCommand,
  describeOptions,
  HELP,
  OptionsError,
  parseCli,
  RAW_OPTIONS,
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

function metrics(result: AskResult): string {
  const format =
    result.format === "text"
      ? "формат не задан"
      : result.validation.ok
        ? "формат ✓"
        : `формат ✗ (${result.validation.reason})`;

  const spent =
    result.reasoningTokens > 0
      ? `${result.completionTokens}, из них рассуждение ${result.reasoningTokens}`
      : `${result.completionTokens}`;

  const line =
    `— токенов ${result.totalTokens} (ответ ${spent}), символов ${result.answer.length}, ` +
    `finish_reason: ${result.finishReason}, ${format}`;

  return `${line}${diagnose(result)}${temperatureNote(result)}`;
}

function render(result: AskResult): string {
  return result.answer.length > 0 ? result.answer : "(пустой ответ)";
}

function fail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (cli.compare) {
  console.log(`\nЗапрос: ${cli.prompt}`);
  console.log(`Модель: ${model}\n`);

  try {
    const [raw, limited] = await Promise.all([
      ask(client, model, [], cli.prompt, RAW_OPTIONS),
      ask(client, model, [], cli.prompt, options),
    ]);

    console.log("─── БЕЗ ОГРАНИЧЕНИЙ ───────────────────────────────");
    console.log(`режим: ${describeOptions(RAW_OPTIONS)}\n`);
    console.log(render(raw));
    console.log(`\n${metrics(raw)}\n`);

    console.log("─── С ОГРАНИЧЕНИЯМИ ───────────────────────────────");
    console.log(`режим: ${describeOptions(options)}\n`);
    console.log(render(limited));
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

  try {
    for (let run = 1; run <= cli.repeat; run += 1) {
      // Прогоны независимы: history не копится, иначе модель копировала бы прошлый ответ.
      const result = await ask(client, model, [], cli.prompt, options);

      totalTokens += result.totalTokens;
      if (result.validation.ok) valid += 1;

      if (cli.repeat > 1) console.log(`── прогон ${run}/${cli.repeat} ─────────────────`);
      console.log(render(result));
      console.log(`${metrics(result)}\n`);
    }
  } catch (error) {
    console.error("Запрос не удался:", fail(error));
    process.exit(1);
  }

  if (cli.repeat > 1) {
    // При text валидатор всегда доволен — доля валидных ответов ничего не измеряет.
    const held = options.format === "text" ? "" : `Формат выдержан: ${valid}/${cli.repeat}, `;
    console.log(`${held}потрачено токенов: ${totalTokens}`);
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
      const result = await ask(client, model, history, question, options);

      // Реплики дописываются только после успеха и непустого ответа — вопроса без ответа
      // в history не остаётся, иначе следующий запрос уходит с фиктивной репликой ассистента.
      if (result.answer.length > 0) {
        history.push({ role: "user", content: question }, { role: "assistant", content: result.answer });
      }

      totalTokens += result.totalTokens;

      console.log(`\n${render(result)}`);
      console.log(`${metrics(result)}\n`);
    } catch (error) {
      console.error(`\nЗапрос не удался: ${fail(error)}\n`);
    }

    rl.prompt();
  }

  rl.close();
  console.log(`\n— израсходовано токенов за сессию: ${totalTokens}`);
}
