export const DEFAULT_MODEL = "deepseek-v4-flash";

/** Список не закрытый — API может знать больше моделей, здесь только повод предупредить об опечатке. */
export const KNOWN_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"];

export interface ModelTier {
  /** Заголовок секции и первая колонка таблицы. */
  label: string;
  model: string;
  thinkingEnabled: boolean;
}

/**
 * Уровень — пара (модель, thinking), а не только id: без рассуждения flash ведёт себя иначе.
 * Третьей модели у DeepSeek нет — третья строка получена из той же flash отключением thinking.
 */
export const SWEEP_MODELS: ModelTier[] = [
  { label: "flash, thinking off", model: "deepseek-v4-flash", thinkingEnabled: false },
  { label: "flash", model: "deepseek-v4-flash", thinkingEnabled: true },
  { label: "pro", model: "deepseek-v4-pro", thinkingEnabled: true },
];
