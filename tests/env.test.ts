import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "../src/env.ts";

const API_KEY_MESSAGE = "Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.";

const saved = { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL };

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file or directory, open '.env'"), { code: "ENOENT" });
}

describe("readEnv", () => {
  beforeEach(() => {
    // Иначе .env самого репозитория подмешал бы настоящий ключ в проверки его отсутствия.
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_MODEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = saved.model;
  });

  it("без ключа объясняет, что делать, а не показывает ошибку схемы", () => {
    expect(() => readEnv()).toThrow(API_KEY_MESSAGE);
  });

  it("пустой ключ равносилен его отсутствию", () => {
    process.env.DEEPSEEK_API_KEY = "";

    expect(() => readEnv()).toThrow(API_KEY_MESSAGE);
  });

  it("отдаёт ключ и модель из окружения", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";

    expect(readEnv()).toEqual({ apiKey: "sk-test", model: "deepseek-v4-pro" });
  });

  it("пустая DEEPSEEK_MODEL — тот же случай, что и её отсутствие: модель возьмут из флага или дефолта", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.DEEPSEEK_MODEL = "";

    expect(readEnv().model).toBeNull();
  });

  it("отсутствие .env не ошибка: ключ может прийти из окружения", () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw enoent();
    });
    process.env.DEEPSEEK_API_KEY = "sk-test";

    expect(readEnv().apiKey).toBe("sk-test");
  });

  it("любая другая ошибка чтения .env пробрасывается", () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    process.env.DEEPSEEK_API_KEY = "sk-test";

    expect(() => readEnv()).toThrow("EACCES: permission denied");
  });
});
