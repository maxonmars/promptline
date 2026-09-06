import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import OpenAI from "openai";
import { type Env, readEnv } from "./env.ts";
import { DEFAULT_MODEL, SWEEP_MODELS } from "./models.ts";
import {
  applySlashCommand,
  type Cli,
  describeOptions,
  HELP,
  OptionsError,
  parseCli,
  RAW_OPTIONS,
  SWEEP_TEMPERATURES,
} from "./options.ts";
import {
  describeExpect,
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
  strategyFootnotes,
  strategyTable,
  type TemperatureTally,
  temperatureFootnotes,
  temperatureTable,
} from "./report.ts";
import { answerKey, StrategyError, solve } from "./solve.ts";
import { STRATEGIES, STRATEGY_NAMES, type StrategyName } from "./strategies.ts";

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

let env: Env;

try {
  env = readEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const model = cli.model ?? env.model ?? DEFAULT_MODEL;

// DeepSeek отдаёт OpenAI-совместимый API — хватает подмены baseURL в официальном SDK.
const client = new OpenAI({
  apiKey: env.apiKey,
  baseURL: "https://api.deepseek.com",
  // Совпадают со значениями SDK по умолчанию; явно — потому что ретраи на 429 копятся
  // в elapsedMs у --model=all, но в failures не попадают.
  maxRetries: 2,
  timeout: 600_000,
});

const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];
let options = cli.options;
let totalTokens = 0;

for (const warning of cli.warnings) console.warn(`! ${warning}`);

if (cli.allStrategies) {
  console.log(`\nЗадача: ${cli.prompt}`);
  console.log(`Модель: ${model}`);
  console.log(`Режим: ${describeOptions(options)}`);
  console.log(`Верный ответ: ${describeExpect(cli.expect)}\n`);

  const tally = new Map<StrategyName, StrategyTally>(STRATEGY_NAMES.map((name) => [name, newStrategyTally()]));

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

  console.log("═══ ИТОГО ══════════════════════════════════════════\n");
  console.log(strategyTable(tally, cli.expect !== null));

  for (const line of strategyFootnotes(tally)) console.log(line);

  console.log(`\nвсего потрачено токенов: ${totalTokens}`);
} else if (cli.allTemperatures) {
  console.log(`\nЗапрос: ${cli.prompt}`);
  console.log(`Модель: ${model}`);
  console.log(`Режим: ${describeOptions(options)}`);
  console.log(`Температуры: ${SWEEP_TEMPERATURES.join(", ")}`);
  console.log(`Верный ответ: ${describeExpect(cli.expect)}\n`);

  const tally = new Map<number, TemperatureTally>(
    SWEEP_TEMPERATURES.map((temperature) => [temperature, newTemperatureTally()]),
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

  console.log("═══ ИТОГО ══════════════════════════════════════════\n");
  console.log(temperatureTable(tally, cli.expect !== null));

  for (const line of temperatureFootnotes(tally)) console.log(line);

  console.log(`\nвсего потрачено токенов: ${totalTokens}`);
} else if (cli.allModels) {
  console.log(`\nЗапрос: ${cli.prompt}`);
  console.log(`Уровни: ${SWEEP_MODELS.map((tier) => tier.label).join(" / ")}`);
  console.log(`Верный ответ: ${describeExpect(cli.expect)}\n`);

  const tally = new Map<string, ModelTally>(SWEEP_MODELS.map((tier) => [tier.label, newModelTally()]));

  // Уровень внешним циклом, как и температура: ответы одной настройки идут подряд, иначе
  // разброс не читается, а последовательные вызовы не делят общий rate limit.
  for (const tier of SWEEP_MODELS) {
    const stats = tally.get(tier.label)!;
    // thinking задаёт сам уровень — не общий options.thinkingEnabled, который --model=all не трогает.
    const tierOptions = { ...options, thinkingEnabled: tier.thinkingEnabled };

    console.log(`─── ${tier.label} (${tier.model}) ───────────────────`);
    console.log(`режим: ${describeOptions(tierOptions)}\n`);

    for (let run = 1; run <= cli.repeat; run += 1) {
      stats.attempts += 1;

      try {
        // Прогоны независимы: history не копится, иначе модель копировала бы прошлый ответ.
        const result = await solve(client, tier.model, [], cli.prompt, tierOptions, cli.expect);

        if (cli.repeat > 1) console.log(`── прогон ${run}/${cli.repeat} ─────────────────`);

        if (result.generatedPrompt !== null) {
          console.log(`\nпромпт, сочинённый моделью:\n${result.generatedPrompt}\n\nответ по этому промпту:`);
        }

        console.log(`\n${render(result.final)}`);
        console.log(`${metrics(result)}\n`);

        totalTokens += result.totalTokens;

        // У reasoning-модели пустой content приходит без исключения. Прогон оплачен, ответа нет —
        // в среднюю цену ответа он не идёт, как и сбой.
        if (result.final.answer.length === 0) {
          stats.empty += 1;
        } else {
          stats.runs += 1;
          stats.tokens += result.totalTokens;
          stats.reasoning += result.reasoningTokens;
          stats.ms += result.elapsedMs;

          if (result.finalValue !== null) stats.extracted += 1;
          if (result.hit === true) stats.hits += 1;
        }
      } catch (error) {
        console.error(`\n— ошибка: ${fail(error)}\n`);
        stats.failures += 1;

        // В tokens/ms уровня не идёт: средние на полученный ответ иначе занижались бы сбоем.
        if (error instanceof StrategyError) totalTokens += error.spentTokens;
      }
    }
  }

  const measured = cli.expect !== null;

  console.log("═══ ИТОГО ══════════════════════════════════════════\n");
  console.log("токены, рассуждение и время — средние на один полученный ответ, не сумма\n");
  console.log(modelTable(tally, measured));

  for (const line of modelFootnotes(tally, measured)) console.log(line);

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
        history.push({ role: "user", content: question }, { role: "assistant", content: result.final.answer });
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
