export type FormatName = "json" | "md" | "yaml" | "text";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface FormatSpec {
  /** Блок системного промпта с описанием формата. Пустая строка — формат не навязывается. */
  instruction: string;
  validate(answer: string): ValidationResult;
}

const ITEM_FIELDS = ["order", "name", "weight"] as const;

const MD_HEADINGS = ["## Кратко", "## Пункты"];

function validateJson(answer: string): ValidationResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(answer);
  } catch {
    return { ok: false, reason: "не разбирается как JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "на верхнем уровне не объект" };
  }

  if (!("summary" in parsed)) {
    return { ok: false, reason: "нет поля summary" };
  }

  const { items } = parsed as { items?: unknown };

  if (!Array.isArray(items)) {
    return { ok: false, reason: "нет массива items" };
  }

  for (const [index, item] of items.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: `items[${index}] не объект` };
    }

    const missing = ITEM_FIELDS.filter((field) => !(field in item));

    if (missing.length > 0) {
      return { ok: false, reason: `items[${index}] без полей: ${missing.join(", ")}` };
    }
  }

  return { ok: true };
}

function validateMd(answer: string): ValidationResult {
  const missing = MD_HEADINGS.filter((heading) => !answer.includes(heading));

  return missing.length > 0 ? { ok: false, reason: `нет заголовков: ${missing.join(", ")}` } : { ok: true };
}

function validateYaml(answer: string): ValidationResult {
  const missing = ["summary", "items"].filter((key) => !new RegExp(`^${key}:`, "m").test(answer));

  return missing.length > 0 ? { ok: false, reason: `нет ключей: ${missing.join(", ")}` } : { ok: true };
}

/**
 * Три формата описывают один и тот же контракт — summary плюс items с полями order/name/weight.
 * Сменить предметную область — значит переписать эти instruction и ITEM_FIELDS.
 */
export const FORMATS: Record<FormatName, FormatSpec> = {
  // Слово «json» обязано быть в промпте: без него DeepSeek отклоняет response_format: json_object.
  json: {
    instruction: [
      "Отвечай только валидным json-объектом по схеме:",
      '{"summary": "строка, одно предложение", "items": [{"order": число, "name": "строка", "weight": "строка"}]}',
      "Никакого текста до и после json, никакой обёртки в markdown-блок.",
    ].join("\n"),
    validate: validateJson,
  },

  md: {
    instruction: [
      "Отвечай строго по шаблону markdown, не меняя заголовки:",
      "",
      "## Кратко",
      "<одно предложение>",
      "",
      "## Пункты",
      "1. **<name>** — <weight>",
      "",
      "Без вступлений и заключений.",
    ].join("\n"),
    validate: validateMd,
  },

  yaml: {
    instruction: [
      "Отвечай строго YAML по схеме, не меняя ключи:",
      "",
      "summary: <одно предложение>",
      "items:",
      "  - order: <число>",
      "    name: <строка>",
      "    weight: <строка>",
      "",
      "Без обёртки в markdown-блок, без пояснений.",
    ].join("\n"),
    validate: validateYaml,
  },

  text: {
    instruction: "",
    validate: () => ({ ok: true }),
  },
};

export const FORMAT_NAMES = Object.keys(FORMATS) as FormatName[];
