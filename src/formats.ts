import * as YAML from "yaml";
import { z } from "zod";

export const FORMAT_NAMES = ["json", "md", "yaml", "text"] as const;

export const FormatNameSchema = z.enum(FORMAT_NAMES, {
  error: (issue) => `Неизвестный формат «${issue.input}». Доступны: ${FORMAT_NAMES.join(", ")}.`,
});

export type FormatName = z.infer<typeof FormatNameSchema>;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface FormatSpec {
  /** Блок системного промпта с описанием формата. Пустая строка — формат не навязывается. */
  instruction: string;
  validate(answer: string): ValidationResult;
}

const MD_HEADINGS = ["## Кратко", "## Пункты"];

/** Общий контракт json и yaml: summary плюс items с order/name/weight. */
const ContractSchema = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      order: z.number(),
      name: z.string(),
      weight: z.string(),
    }),
  ),
});

function describePath(path: PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc.length > 0 ? `${acc}.${String(segment)}` : String(segment);
  }, "");
}

function expectedPhrase(expected: string): string {
  switch (expected) {
    case "string":
      return "ожидалась строка";
    case "number":
      return "ожидалось число";
    case "array":
      return "ожидался массив";
    case "object":
      return "ожидался объект";
    default:
      return `ожидался тип ${expected}`;
  }
}

/** Zod не кладёт исходное значение в issue — приходится доставать его из разобранного ответа самим. */
function resolvePath(root: unknown, path: PropertyKey[]): unknown {
  let current = root;

  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return current;
}

function describeIssue(issue: z.core.$ZodIssue, root: unknown): string {
  const path = describePath(issue.path);

  if (issue.code === "invalid_type") {
    if (path.length === 0 && issue.expected === "object") return "на верхнем уровне не объект";
    if (resolvePath(root, issue.path) === undefined) return path.length > 0 ? `нет поля ${path}` : "нет поля";

    return path.length > 0 ? `${path}: ${expectedPhrase(issue.expected)}` : expectedPhrase(issue.expected);
  }

  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/** Перечисляет все нарушения контракта, а не только первое найденное. */
function describeContractIssues(error: z.ZodError, root: unknown): string {
  return error.issues.map((issue) => describeIssue(issue, root)).join("; ");
}

function validateJson(answer: string): ValidationResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(answer);
  } catch {
    return { ok: false, reason: "не разбирается как JSON" };
  }

  const result = ContractSchema.safeParse(parsed);

  return result.success ? { ok: true } : { ok: false, reason: describeContractIssues(result.error, parsed) };
}

function validateMd(answer: string): ValidationResult {
  const missing = MD_HEADINGS.filter((heading) => !answer.includes(heading));

  return missing.length > 0 ? { ok: false, reason: `нет заголовков: ${missing.join(", ")}` } : { ok: true };
}

/**
 * Строго, без снятия markdown-ограждения: инструкция формата прямо требует «без обёртки в
 * markdown-блок», и json на такой обёртке уже падает — прощающий валидатор здесь измерял бы
 * не то, что заявляет контракт.
 */
function validateYaml(answer: string): ValidationResult {
  let parsed: unknown;

  try {
    parsed = YAML.parse(answer);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `не разбирается как YAML: ${reason}` };
  }

  const result = ContractSchema.safeParse(parsed);

  return result.success ? { ok: true } : { ok: false, reason: describeContractIssues(result.error, parsed) };
}

/**
 * Три формата описывают один и тот же контракт — summary плюс items с полями order/name/weight,
 * проверяемый общей ContractSchema у json и yaml. Сменить предметную область — значит переписать
 * эти instruction и ContractSchema. У md контракт не проверяется: заголовки — не структура,
 * а substring-проверка.
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
