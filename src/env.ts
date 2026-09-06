import { z } from "zod";

const API_KEY_MESSAGE = "Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.";

const EnvSchema = z.object({
  // Ключ отдельным .min() не поймать: у отсутствующей переменной сработала бы проверка типа
  // (undefined вместо string) раньше .min(), и вместо этого сообщения ушло бы английское дефолтное.
  DEEPSEEK_API_KEY: z.string(API_KEY_MESSAGE).min(1, API_KEY_MESSAGE),
  // Без .min(): пустая строка (DEEPSEEK_MODEL= без значения) — не ошибка, а тот же случай, что и
  // отсутствие переменной, иначе валидное --model=NAME не запускало бы CLI из-за пустой строки в .env.
  DEEPSEEK_MODEL: z.string().optional(),
});

export interface Env {
  apiKey: string;
  model: string | null;
}

// .env необязателен — переменные могут прийти из окружения, а loadEnvFile бросает на его отсутствие.
// Значения из окружения он не перекрывает.
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** Бросает при отсутствии ключа — вызывающий печатает сообщение и завершает процесс сам. */
export function readEnv(): Env {
  loadEnvFile();

  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Некорректное окружение.");
  }

  const model = result.data.DEEPSEEK_MODEL;

  return { apiKey: result.data.DEEPSEEK_API_KEY, model: model && model.length > 0 ? model : null };
}
