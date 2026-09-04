import { parseArgs } from "node:util";
import { FORMATS, FORMAT_NAMES, type FormatName } from "./formats.js";
import { FINAL_CONTRACT, STRATEGIES, STRATEGY_NAMES, type StrategyName } from "./strategies.js";

export interface ResponseOptions {
  /** Способ рассуждения: как думать, в отличие от format — как оформить. */
  strategy: StrategyName;
  format: FormatName;
  /** Инструкция о длине в промпте — модель её трактует сама. */
  maxWords: number | null;
  /**
   * Жёсткая крышка API, finish_reason становится "length". У reasoning-моделей покрывает
   * рассуждение вместе с ответом, поэтому по умолчанию не ставится — длину задаёт maxWords.
   */
  maxTokens: number | null;
  /** Sentinel: уходит и в промпт как инструкция, и в параметр stop. */
  stopMarker: string | null;
  temperature: number | null;
  /** DeepSeek игнорирует temperature, пока это true (thinking mode включён — так по умолчанию). */
  thinkingEnabled: boolean;
  /** Требовать в ответе строку FINAL: — по ней --expect сверяет итог. */
  finalLine: boolean;
}

export interface Cli {
  prompt: string;
  options: ResponseOptions;
  compare: boolean;
  /** --strategy=all: прогон всех четырёх способов на одном вопросе. */
  allStrategies: boolean;
  /** Варианты верного ответа из --expect; null — точность не измеряется. */
  expect: string[] | null;
  repeat: number;
  help: boolean;
  warnings: string[];
}

export interface CommandResult {
  options: ResponseOptions;
  output: string;
}

export class OptionsError extends Error {}

const BASE_PROMPT = "Ты полезный ассистент. Отвечай кратко и по делу.";

/** Пресет со всеми ограничениями: включается флагом --strict, командой /strict и внутри --compare. */
export const STRICT_OPTIONS: ResponseOptions = {
  // Поле обязательно по типу, но при переключении пресета способ сохраняется — см. applySlashCommand.
  strategy: "direct",
  format: "json",
  maxWords: 60,
  maxTokens: null,
  stopMarker: "<<<END>>>",
  // DeepSeek игнорирует temperature, пока у reasoning-моделей включён thinking mode (по умолчанию
  // для v4-flash/v4-pro), поэтому ставить её в пресет бессмысленно — CLI предупредит, если задать явно.
  temperature: null,
  thinkingEnabled: true,
  finalLine: false,
};

/** База без ограничений — свободный текст с историей диалога, стартовый режим по умолчанию. */
export const RAW_OPTIONS: ResponseOptions = {
  strategy: "direct",
  format: "text",
  maxWords: null,
  maxTokens: null,
  stopMarker: null,
  temperature: null,
  thinkingEnabled: true,
  finalLine: false,
};

export const HELP = `promptline — диалог с LLM через DeepSeek API.

  npm run dev -- [флаги] ["вопрос"]        -- обязателен, иначе npm съест флаги

Без вопроса запускается интерактивный диалог, флаги задают стартовый режим.
По умолчанию ограничений нет — свободный текст с историей. Включить их разом: --strict.

Режим
      --strict                     пресет ограничений: json, 60 слов, стоп-секвенция
      --raw                        без ограничений (так по умолчанию)

Способ рассуждения
      --strategy=NAME              direct|steps|meta|experts|all (по умолчанию direct)
                                   all — прогнать все четыре и сравнить
      --expect=ВАРИАНТ|ВАРИАНТ     верный ответ; сверяется со строкой FINAL: в конце ответа

Формат ответа
  -f, --format=json|md|yaml|text   схема ответа (по умолчанию text)

Длина ответа
      --max-words=N                инструкция в промпте (в --strict — 60)
      --max-tokens=N               жёсткий обрыв на стороне API, включая рассуждение модели

Завершение
      --stop=SEQ                   стоп-секвенция (в --strict — <<<END>>>)
      --no-stop                    не передавать stop

Прочее
      --temperature=N              0..2; у reasoning-моделей DeepSeek её игнорирует (thinking mode)
      --thinking=on|off            выключить thinking mode — тогда temperature реально влияет
      --compare                    один вопрос дважды: без ограничений и с ними (--strict)
      --repeat=N                   N независимых прогонов, проверка стабильности формата
  -h, --help                       эта справка

Команды внутри диалога
  /limits              показать текущий режим        /format <name>   сменить формат
  /strategy <name>     способ рассуждения            /len <N>         лимит слов в промпте
  /stop <seq|off>      стоп-секвенция                /tokens <N>      лимит токенов API
  /raw                 снять ограничения             /temp <N>        температура
  /thinking on|off     thinking mode                 /strict          включить пресет ограничений
  /help                справка                       /exit            завершить сессию`;

/** Стоп-маркер попал бы внутрь json и сломал разбор — при json_object его роль играет закрывающая скобка. */
function dropStopForJson(options: ResponseOptions, warnings: string[]): void {
  if (options.format !== "json" || options.stopMarker === null) return;

  const explicit = options.stopMarker !== STRICT_OPTIONS.stopMarker;
  options.stopMarker = null;

  if (explicit) {
    warnings.push("Стоп-секвенция снята: с --format=json завершение обеспечивает response_format.");
  }
}

function parseCount(raw: string, flag: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new OptionsError(`${flag} ждёт целое положительное число, получено «${raw}».`);
  }

  return value;
}

function parseFormat(raw: string): FormatName {
  if (!FORMAT_NAMES.includes(raw as FormatName)) {
    throw new OptionsError(`Неизвестный формат «${raw}». Доступны: ${FORMAT_NAMES.join(", ")}.`);
  }

  return raw as FormatName;
}

/** "all" разбирается отдельно: это не значение режима, а команда прогнать все способы. */
function parseStrategy(raw: string): StrategyName {
  if (!STRATEGY_NAMES.includes(raw as StrategyName)) {
    throw new OptionsError(
      `Неизвестный способ «${raw}». Доступны: ${STRATEGY_NAMES.join(", ")} (all — только флагом --strategy=all).`,
    );
  }

  return raw as StrategyName;
}

function parseExpect(raw: string): string[] {
  const variants = raw
    .split("|")
    .map((variant) => variant.trim())
    .filter((variant) => variant.length > 0);

  if (variants.length === 0) {
    throw new OptionsError("--expect ждёт верный ответ, варианты через |. Например: --expect=\"1/2|50%\".");
  }

  return variants;
}

/**
 * Рассуждение и схема ответа — взаимоисключающие контракты: схема summary/items вытеснит разбор,
 * а строка FINAL сломает разбор json. Сочетание отклоняется, иначе полуприменённый способ попал бы
 * в сравнение как полноценный.
 */
function ensureCompatible(options: ResponseOptions, reasoning: boolean): void {
  if (options.format === "text") return;

  if (reasoning) {
    throw new OptionsError(
      `Способ рассуждения не сочетается с форматом ${options.format}: схема ответа вытеснит разбор. Нужен --format=text.`,
    );
  }

  if (options.finalLine) {
    throw new OptionsError(
      `--expect не сочетается с форматом ${options.format}: строка FINAL сломает разбор. Нужен --format=text.`,
    );
  }
}

function parseTemperature(raw: string): number {
  if (raw.trim().length === 0) {
    throw new OptionsError("--temperature ждёт число от 0 до 2, значение не задано.");
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new OptionsError(`--temperature ждёт число от 0 до 2, получено «${raw}».`);
  }

  return value;
}

function parseThinking(raw: string): boolean {
  if (raw === "on") return true;
  if (raw === "off") return false;

  throw new OptionsError(`--thinking ждёт on или off, получено «${raw}».`);
}

export function parseCli(argv: string[]): Cli {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        strategy: { type: "string" },
        expect: { type: "string" },
        format: { type: "string", short: "f" },
        "max-words": { type: "string" },
        "max-tokens": { type: "string" },
        stop: { type: "string" },
        "no-stop": { type: "boolean" },
        temperature: { type: "string" },
        thinking: { type: "string" },
        raw: { type: "boolean" },
        strict: { type: "boolean" },
        compare: { type: "boolean" },
        repeat: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new OptionsError(error instanceof Error ? error.message : String(error));
  }

  const warnings: string[] = [];

  // --compare без --strict всё равно берёт строгий пресет: иначе обе колонки окажутся одинаковыми.
  const strictStart = !values.raw && (values.strict === true || values.compare === true);
  const options: ResponseOptions = strictStart ? { ...STRICT_OPTIONS } : { ...RAW_OPTIONS };

  const allStrategies = values.strategy === "all";

  if (typeof values.strategy === "string" && !allStrategies) options.strategy = parseStrategy(values.strategy);
  if (typeof values.format === "string") options.format = parseFormat(values.format);
  if (typeof values["max-words"] === "string") options.maxWords = parseCount(values["max-words"], "--max-words");
  if (typeof values["max-tokens"] === "string") options.maxTokens = parseCount(values["max-tokens"], "--max-tokens");
  if (typeof values.temperature === "string") options.temperature = parseTemperature(values.temperature);
  if (typeof values.thinking === "string") options.thinkingEnabled = parseThinking(values.thinking);

  if (typeof values.stop === "string") {
    if (values.stop.length === 0) throw new OptionsError("--stop ждёт непустую строку.");
    options.stopMarker = values.stop;
  }

  if (values["no-stop"]) options.stopMarker = null;

  dropStopForJson(options, warnings);

  const compare = values.compare === true;
  const repeat = typeof values.repeat === "string" ? parseCount(values.repeat, "--repeat") : 1;
  const prompt = positionals.join(" ").trim();
  const expect = typeof values.expect === "string" ? parseExpect(values.expect) : null;

  if (compare && repeat > 1) throw new OptionsError("--compare и --repeat вместе не работают.");
  if (compare && !prompt) throw new OptionsError("--compare требует вопрос аргументом.");
  if (repeat > 1 && !prompt) throw new OptionsError("--repeat требует вопрос аргументом.");
  if (allStrategies && !prompt) throw new OptionsError("--strategy=all требует вопрос аргументом.");

  if (allStrategies && compare) {
    throw new OptionsError("--strategy=all и --compare вместе не работают: это два разных сравнения.");
  }

  if (expect !== null && !prompt) {
    warnings.push("--expect не действует в интерактивном диалоге: точность измеряется только на вопросе аргументом.");
  }

  // Контракт FINAL нужен только когда точность реально измеряется.
  options.finalLine = expect !== null && prompt.length > 0;

  ensureCompatible(options, allStrategies || options.strategy !== "direct");

  return { prompt, options, compare, allStrategies, expect, repeat, help: values.help === true, warnings };
}

/**
 * extraSystem занимает место инструкции способа — у meta это сочинённый моделью промпт.
 * Он идёт до блоков формата, длины и FINAL: те задают контракт ответа и должны быть последними,
 * иначе сгенерированный текст перебивает их рецентностью.
 */
export function buildSystemPrompt(options: ResponseOptions, extraSystem?: string): string {
  // Сначала как думать, потом как оформить.
  const blocks = [
    BASE_PROMPT,
    STRATEGIES[options.strategy].instruction,
    extraSystem ?? "",
    FORMATS[options.format].instruction,
  ];

  if (options.maxWords !== null) {
    blocks.push(`Уложись в ${options.maxWords} слов. Лучше выкинуть детали, чем превысить лимит.`);
  }

  if (options.finalLine) blocks.push(FINAL_CONTRACT);

  if (options.stopMarker !== null) {
    blocks.push(`Закончив ответ, выведи ${options.stopMarker} и больше ничего не пиши.`);
  }

  return blocks.filter((block) => block.length > 0).join("\n\n");
}

export function describeOptions(options: ResponseOptions): string {
  return [
    `способ: ${options.strategy}`,
    `формат: ${options.format}`,
    `слов: ${options.maxWords ?? "без лимита"}`,
    `токенов: ${options.maxTokens ?? "без лимита"}`,
    `stop: ${options.stopMarker ?? "нет"}`,
    `temperature: ${options.temperature ?? "по умолчанию"}`,
    `thinking: ${options.thinkingEnabled ? "on" : "off"}`,
  ].join(", ");
}

/** Возвращает null, если строка — обычный вопрос, а не команда. */
export function applySlashCommand(line: string, current: ResponseOptions): CommandResult | null {
  if (!line.startsWith("/")) return null;

  const [command, ...rest] = line.slice(1).split(/\s+/);
  const argument = rest.join(" ");
  const options = { ...current };
  const warnings: string[] = [];

  const changed = (): CommandResult => {
    dropStopForJson(options, warnings);
    ensureCompatible(options, options.strategy !== "direct");
    return { options, output: [...warnings, describeOptions(options)].join("\n") };
  };

  try {
    switch (command) {
      case "help":
        return { options, output: HELP };
      case "limits":
        return { options, output: describeOptions(options) };
      // Пресеты задают формат и лимиты; выбранный способ рассуждения они не сбрасывают.
      case "raw":
        Object.assign(options, RAW_OPTIONS, { strategy: current.strategy });
        return changed();
      case "strict":
        Object.assign(options, STRICT_OPTIONS, { strategy: current.strategy });
        return changed();
      case "strategy":
        options.strategy = parseStrategy(argument);
        return changed();
      case "format":
        options.format = parseFormat(argument);
        return changed();
      case "len":
        options.maxWords = parseCount(argument, "/len");
        return changed();
      case "tokens":
        options.maxTokens = parseCount(argument, "/tokens");
        return changed();
      case "temp":
        options.temperature = parseTemperature(argument);
        return changed();
      case "thinking":
        options.thinkingEnabled = parseThinking(argument);
        return changed();
      case "stop":
        if (argument === "off") options.stopMarker = null;
        else if (argument.length === 0) throw new OptionsError("/stop ждёт секвенцию или off.");
        else options.stopMarker = argument;
        return changed();
      default:
        return { options: current, output: `Неизвестная команда /${command}. Список — /help.` };
    }
  } catch (error) {
    if (error instanceof OptionsError) return { options: current, output: error.message };
    throw error;
  }
}
