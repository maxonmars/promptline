import { describe, expect, it } from "vitest";
import {
  applySlashCommand,
  buildSystemPrompt,
  describeOptions,
  HELP,
  OptionsError,
  parseCli,
  RAW_OPTIONS,
  type ResponseOptions,
  STRICT_OPTIONS,
} from "../src/options.ts";
import { FINAL_CONTRACT, STRATEGIES } from "../src/strategies.ts";

function withOptions(overrides: Partial<ResponseOptions>): ResponseOptions {
  return { ...RAW_OPTIONS, ...overrides };
}

describe("parseCli: пресеты", () => {
  it("без флагов берёт пресет без ограничений", () => {
    expect(parseCli([]).options).toEqual(RAW_OPTIONS);
  });

  it("--strict включает ограничения, но стоп-маркер снимает json — молча, маркер из самого пресета", () => {
    const cli = parseCli(["--strict"]);

    expect(cli.options.format).toBe("json");
    expect(cli.options.maxWords).toBe(60);
    expect(cli.options.stopMarker).toBeNull();
    expect(cli.warnings).toEqual([]);
  });

  it("--strict с форматом кроме json оставляет стоп-секвенцию пресета", () => {
    expect(parseCli(["--strict", "--format=md"]).options.stopMarker).toBe(STRICT_OPTIONS.stopMarker);
  });

  it("--compare без --strict стартует со строгого пресета: иначе обе колонки одинаковы", () => {
    expect(parseCli(["--compare", "вопрос"]).options.format).toBe("json");
  });

  it("--raw перебивает строгий старт --compare", () => {
    expect(parseCli(["--compare", "--raw", "вопрос"]).options.format).toBe("text");
  });

  it("--no-stop снимает стоп-секвенцию пресета", () => {
    expect(parseCli(["--strict", "--format=md", "--no-stop"]).options.stopMarker).toBeNull();
  });

  it("явные флаги применяются поверх пресета", () => {
    const cli = parseCli(["--strict", "--format=md", "--max-words=10", "--max-tokens=500"]);

    expect(cli.options).toMatchObject({ format: "md", maxWords: 10, maxTokens: 500 });
  });

  it("позиционные аргументы склеиваются в один вопрос", () => {
    expect(parseCli(["сколько", "будет", "два"]).prompt).toBe("сколько будет два");
  });
});

describe("parseCli: стоп-секвенция и json", () => {
  it("заданную вручную стоп-секвенцию json снимает с предупреждением", () => {
    const cli = parseCli(["--format=json", "--stop=@@"]);

    expect(cli.options.stopMarker).toBeNull();
    expect(cli.warnings).toEqual(["Стоп-секвенция снята: с --format=json завершение обеспечивает response_format."]);
  });

  it("с форматом кроме json заданная секвенция остаётся", () => {
    expect(parseCli(["--stop=@@"]).options.stopMarker).toBe("@@");
  });
});

describe("parseCli: несовместимые оси", () => {
  const cases: [string, string[]][] = [
    ["--compare и --repeat вместе не работают.", ["--compare", "--repeat=2", "вопрос"]],
    ["--compare требует вопрос аргументом.", ["--compare"]],
    ["--repeat требует вопрос аргументом.", ["--repeat=2"]],
    ["--strategy=all требует вопрос аргументом.", ["--strategy=all"]],
    ["--strategy=all и --compare вместе не работают", ["--strategy=all", "--compare", "вопрос"]],
    ["--temperature=all требует вопрос аргументом.", ["--temperature=all"]],
    ["--temperature=all и --compare вместе не работают", ["--temperature=all", "--compare", "вопрос"]],
    ["--temperature=all и --strategy=all вместе не работают", ["--temperature=all", "--strategy=all", "вопрос"]],
    ["--model=all требует вопрос аргументом.", ["--model=all"]],
    ["--model=all и --compare вместе не работают", ["--model=all", "--compare", "вопрос"]],
    ["--model=all и --strategy=all вместе не работают", ["--model=all", "--strategy=all", "вопрос"]],
    ["--model=all и --temperature=all вместе не работают", ["--model=all", "--temperature=all", "вопрос"]],
    ["--model=all и --thinking вместе не работают", ["--model=all", "--thinking=off", "вопрос"]],
  ];

  it.each(cases)("отклоняет сочетание: %s", (message, argv) => {
    expect(() => parseCli(argv)).toThrow(OptionsError);
    expect(() => parseCli(argv)).toThrow(message);
  });
});

describe("parseCli: разбор значений", () => {
  const cases: [string, string[]][] = [
    ["Неизвестный формат «xml». Доступны: json, md, yaml, text.", ["--format=xml"]],
    ["Неизвестный способ «zzz»", ["--strategy=zzz"]],
    ["--max-words ждёт целое положительное число, получено «0».", ["--max-words=0"]],
    ["--max-words ждёт целое положительное число, получено «две».", ["--max-words=две"]],
    ["--max-tokens ждёт целое положительное число, получено «-5».", ["--max-tokens=-5"]],
    ["--repeat ждёт целое положительное число, получено «1.5».", ["--repeat=1.5", "вопрос"]],
    ["--temperature ждёт число от 0 до 2, получено «3».", ["--temperature=3"]],
    ["--temperature ждёт число от 0 до 2, значение не задано.", ["--temperature="]],
    ["--thinking ждёт on или off, получено «maybe».", ["--thinking=maybe"]],
    ["--stop ждёт непустую строку.", ["--stop="]],
    ["--model ждёт идентификатор модели, значение не задано.", ["--model="]],
    ['--expect ждёт верный ответ, варианты через |. Например: --expect="1/2|50%".', ["--expect= | ", "вопрос"]],
  ];

  it.each(cases)("сообщает причину: %s", (message, argv) => {
    expect(() => parseCli(argv)).toThrow(message);
  });

  it("неизвестный флаг доходит до вызывающего как OptionsError, а не как ошибка parseArgs", () => {
    expect(() => parseCli(["--bogus"])).toThrow(OptionsError);
  });

  it("--expect разбивает варианты по | и обрезает пробелы", () => {
    expect(parseCli(["--expect=Даша | Аня", "вопрос"]).expect).toEqual(["Даша", "Аня"]);
  });

  it("--thinking=off выключает thinking mode", () => {
    expect(parseCli(["--thinking=off"]).options.thinkingEnabled).toBe(false);
  });
});

describe("parseCli: предупреждения", () => {
  it("неизвестная модель не отклоняется, а предупреждает об опечатке", () => {
    const cli = parseCli(["--model=deepseek-v5"]);

    expect(cli.model).toBe("deepseek-v5");
    expect(cli.warnings[0]).toContain("Модель «deepseek-v5» не входит в известные");
  });

  it("известная модель проходит без предупреждений", () => {
    expect(parseCli(["--model=deepseek-v4-pro"]).warnings).toEqual([]);
  });

  it("--model=all не считается именем модели", () => {
    const cli = parseCli(["--model=all", "вопрос"]);

    expect(cli.allModels).toBe(true);
    expect(cli.model).toBeNull();
    expect(cli.warnings).toEqual([]);
  });

  it("--temperature=all при включённом thinking предупреждает, но не отклоняется", () => {
    const cli = parseCli(["--temperature=all", "вопрос"]);

    expect(cli.allTemperatures).toBe(true);
    expect(cli.warnings[0]).toContain("--thinking=off");
  });

  it("--temperature=all с --thinking=off проходит молча", () => {
    expect(parseCli(["--temperature=all", "--thinking=off", "вопрос"]).warnings).toEqual([]);
  });

  it("--expect без вопроса предупреждает: в диалоге точность не измеряется", () => {
    const cli = parseCli(["--expect=Даша"]);

    expect(cli.warnings[0]).toContain("--expect не действует в интерактивном диалоге");
  });
});

describe("parseCli: контракт FINAL", () => {
  it("--expect с вопросом включает строку FINAL", () => {
    expect(parseCli(["--expect=Даша", "вопрос"]).options.finalLine).toBe(true);
  });

  it("--temperature=all включает строку FINAL и без --expect: иначе разнообразие всегда N/N", () => {
    expect(parseCli(["--temperature=all", "вопрос"]).options.finalLine).toBe(true);
  });

  it("--model=all сам по себе строку FINAL не включает", () => {
    expect(parseCli(["--model=all", "вопрос"]).options.finalLine).toBe(false);
  });

  it("без вопроса контракт не включается даже с --expect", () => {
    expect(parseCli(["--expect=Даша"]).options.finalLine).toBe(false);
  });
});

describe("parseCli: способ рассуждения против схемы ответа", () => {
  it("способ с json отклоняется на разборе аргументов", () => {
    expect(() => parseCli(["--strategy=steps", "--format=json"])).toThrow(
      "Способ рассуждения не сочетается с форматом json",
    );
  });

  it("--strategy=all тоже считается способом", () => {
    expect(() => parseCli(["--strategy=all", "--format=yaml", "вопрос"])).toThrow(
      "Способ рассуждения не сочетается с форматом yaml",
    );
  });

  it("сообщение о FINAL называет флаг, включивший контракт: --expect", () => {
    expect(() => parseCli(["--expect=Даша", "--format=json", "вопрос"])).toThrow(
      "--expect не сочетается с форматом json",
    );
  });

  it("сообщение о FINAL называет --temperature=all, когда контракт включил он", () => {
    expect(() => parseCli(["--temperature=all", "--format=json", "вопрос"])).toThrow(
      "--temperature=all не сочетается с форматом json",
    );
  });

  it("со свободным текстом способ и контракт уживаются", () => {
    expect(parseCli(["--strategy=steps", "--expect=Даша", "вопрос"]).options.strategy).toBe("steps");
  });
});

describe("buildSystemPrompt", () => {
  it("без ограничений остаётся один базовый блок: пустые блоки не попадают в промпт", () => {
    expect(buildSystemPrompt(RAW_OPTIONS).split("\n\n")).toHaveLength(1);
  });

  it("добавляет инструкцию способа рассуждения", () => {
    expect(buildSystemPrompt(withOptions({ strategy: "steps" }))).toContain(STRATEGIES.steps.instruction);
  });

  it("extraSystem стоит до контракта ответа: иначе сочинённый промпт перебивает его рецентностью", () => {
    const prompt = buildSystemPrompt(
      withOptions({ format: "md", maxWords: 60, finalLine: true, stopMarker: "@@" }),
      "СОЧИНЁННЫЙ ПРОМПТ",
    );

    const positions = [
      prompt.indexOf("СОЧИНЁННЫЙ ПРОМПТ"),
      prompt.indexOf("Отвечай строго по шаблону markdown"),
      prompt.indexOf("Уложись в 60 слов"),
      prompt.indexOf(FINAL_CONTRACT),
      prompt.indexOf("Закончив ответ, выведи @@"),
    ];

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).not.toContain(-1);
  });

  it("extraSystem занимает место инструкции способа, не добавляется к ней", () => {
    const prompt = buildSystemPrompt(withOptions({ strategy: "meta" }), "СОЧИНЁННЫЙ ПРОМПТ");

    expect(prompt.split("\n\n")).toHaveLength(2);
  });
});

describe("describeOptions", () => {
  it("незаданные лимиты называет словами, а не null", () => {
    expect(describeOptions(RAW_OPTIONS)).toBe(
      "способ: direct, формат: text, слов: без лимита, токенов: без лимита, stop: нет, " +
        "temperature: по умолчанию, thinking: on",
    );
  });

  it("показывает заданные значения", () => {
    const line = describeOptions(withOptions({ maxWords: 60, maxTokens: 500, stopMarker: "@@", temperature: 0 }));

    expect(line).toContain("слов: 60");
    expect(line).toContain("токенов: 500");
    expect(line).toContain("stop: @@");
    expect(line).toContain("temperature: 0");
  });
});

describe("applySlashCommand", () => {
  it("обычную реплику командой не считает", () => {
    expect(applySlashCommand("сколько будет два", RAW_OPTIONS)).toBeNull();
  });

  it("/help печатает справку, режим не трогает", () => {
    const result = applySlashCommand("/help", RAW_OPTIONS)!;

    expect(result.output).toBe(HELP);
    expect(result.options).toEqual(RAW_OPTIONS);
  });

  it("/limits показывает текущий режим", () => {
    expect(applySlashCommand("/limits", RAW_OPTIONS)!.output).toBe(describeOptions(RAW_OPTIONS));
  });

  it("/raw снимает ограничения, но сохраняет выбранный способ", () => {
    const current = withOptions({ strategy: "experts", maxWords: 60, stopMarker: "@@" });
    const result = applySlashCommand("/raw", current)!;

    expect(result.options).toEqual({ ...RAW_OPTIONS, strategy: "experts" });
  });

  it("/strict при активном способе отклоняется целиком: json со способом несовместим", () => {
    const current = withOptions({ strategy: "experts" });
    const result = applySlashCommand("/strict", current)!;

    expect(result.options).toEqual(current);
    expect(result.output).toContain("Способ рассуждения не сочетается с форматом json");
  });

  it("/strict без способа включает пресет и снимает стоп-маркер под json", () => {
    const result = applySlashCommand("/strict", RAW_OPTIONS)!;

    expect(result.options).toMatchObject({ format: "json", maxWords: 60, stopMarker: null });
  });

  it("/strategy меняет способ", () => {
    expect(applySlashCommand("/strategy steps", RAW_OPTIONS)!.options.strategy).toBe("steps");
  });

  it("/format json при активном способе отклоняется, режим остаётся прежним", () => {
    const current = withOptions({ strategy: "steps" });
    const result = applySlashCommand("/format json", current)!;

    expect(result.options).toEqual(current);
    expect(result.output).toContain("Способ рассуждения не сочетается с форматом json");
  });

  it("/format json снимает заданную вручную стоп-секвенцию и говорит об этом", () => {
    const result = applySlashCommand("/format json", withOptions({ stopMarker: "@@" }))!;

    expect(result.options.stopMarker).toBeNull();
    expect(result.output).toContain("Стоп-секвенция снята");
  });

  it("/stop off снимает секвенцию, /stop с аргументом задаёт", () => {
    expect(applySlashCommand("/stop off", withOptions({ stopMarker: "@@" }))!.options.stopMarker).toBeNull();
    expect(applySlashCommand("/stop <<<END>>>", RAW_OPTIONS)!.options.stopMarker).toBe("<<<END>>>");
  });

  it("/stop без аргумента объясняет, чего ждёт", () => {
    expect(applySlashCommand("/stop", RAW_OPTIONS)!.output).toBe("/stop ждёт секвенцию или off.");
  });

  it("ошибка называет набранную команду, а не одноимённый флаг", () => {
    const message = (line: string): string => applySlashCommand(line, RAW_OPTIONS)!.output;

    expect(message("/len ноль")).toBe("/len ждёт целое положительное число, получено «ноль».");
    expect(message("/tokens 0")).toBe("/tokens ждёт целое положительное число, получено «0».");
    expect(message("/temp жарко")).toBe("/temp ждёт число от 0 до 2, получено «жарко».");
    expect(message("/temp")).toBe("/temp ждёт число от 0 до 2, значение не задано.");
    expect(message("/thinking maybe")).toBe("/thinking ждёт on или off, получено «maybe».");
  });

  it("ошибка разбора оставляет прежний режим", () => {
    const current = withOptions({ maxWords: 60 });

    expect(applySlashCommand("/len ноль", current)!.options).toBe(current);
  });

  it("/temp и /thinking меняют настройки", () => {
    expect(applySlashCommand("/temp 0.7", RAW_OPTIONS)!.options.temperature).toBe(0.7);
    expect(applySlashCommand("/thinking off", RAW_OPTIONS)!.options.thinkingEnabled).toBe(false);
  });

  it("неизвестная команда отсылает к /help", () => {
    expect(applySlashCommand("/bogus", RAW_OPTIONS)!.output).toBe("Неизвестная команда /bogus. Список — /help.");
  });
});
