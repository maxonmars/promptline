import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TIMEOUT = 20_000;

function withoutKey(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.DEEPSEEK_API_KEY;

  return env;
}

/** Каталог запуска — временный: в корне репозитория лежит .env с настоящим ключом. */
function run(args: string[], env: NodeJS.ProcessEnv = withoutKey()) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", cwd: tmpdir(), env });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("запуск CLI", () => {
  it(
    "--help печатает справку и выходит с нулём, не спрашивая ключ",
    () => {
      const result = run(["--help"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("promptline — диалог с LLM через DeepSeek API.");
      expect(result.stderr).toBe("");
    },
    TIMEOUT,
  );

  it(
    "-h делает то же самое",
    () => {
      expect(run(["-h"]).status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "ошибка разбора флагов уходит в stderr вместе со справкой и даёт код 1",
    () => {
      const result = run(["--compare"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--compare требует вопрос аргументом.");
      expect(result.stderr).toContain("promptline — диалог с LLM через DeepSeek API.");
    },
    TIMEOUT,
  );

  it(
    "неизвестный флаг доходит сообщением parseArgs, а не стектрейсом",
    () => {
      const result = run(["--bogus"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option '--bogus'");
      expect(result.stderr).not.toMatch(/\n\s+at /);
    },
    TIMEOUT,
  );

  it(
    "без ключа CLI останавливается до обращения к API",
    () => {
      const result = run(["вопрос"]);

      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe("Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.");
    },
    TIMEOUT,
  );

  it(
    "справку печатает раньше проверки ключа: она не требует окружения",
    () => {
      expect(run(["--help", "вопрос"]).status).toBe(0);
    },
    TIMEOUT,
  );
});
