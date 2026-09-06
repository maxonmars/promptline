import { describe, expect, it } from "vitest";
import { FORMATS } from "../src/formats.ts";

const validJson = '{"summary":"итог","items":[{"order":1,"name":"первый","weight":"много"}]}';

const validYaml = ["summary: итог", "items:", "  - order: 1", "    name: первый", "    weight: много"].join("\n");

describe("json", () => {
  it("принимает ответ по контракту", () => {
    expect(FORMATS.json.validate(validJson)).toEqual({ ok: true });
  });

  it("пустой список items контракт не нарушает", () => {
    expect(FORMATS.json.validate('{"summary":"итог","items":[]}').ok).toBe(true);
  });

  it("отличает несинтаксичный ответ от нарушения схемы", () => {
    expect(FORMATS.json.validate("вот ваш ответ")).toEqual({ ok: false, reason: "не разбирается как JSON" });
  });

  it("обёртка в markdown-блок проваливает разбор: инструкция формата её прямо запрещает", () => {
    expect(FORMATS.json.validate(`\`\`\`json\n${validJson}\n\`\`\``).ok).toBe(false);
  });

  it("отсутствующее поле называет отсутствующим, а не ошибкой типа", () => {
    expect(FORMATS.json.validate('{"items":[]}').reason).toBe("нет поля summary");
  });

  it("перечисляет все нарушения, а не только первое", () => {
    expect(FORMATS.json.validate("{}").reason).toBe("нет поля summary; нет поля items");
  });

  it("неверный тип поля называет ожидаемый тип и путь", () => {
    expect(FORMATS.json.validate('{"summary":1,"items":[]}').reason).toBe("summary: ожидалась строка");
  });

  it("проверяет типы внутри items, а не только присутствие ключей", () => {
    const answer = '{"summary":"итог","items":[{"order":"1","name":"первый","weight":"много"}]}';

    expect(FORMATS.json.validate(answer).reason).toBe("items[0].order: ожидалось число");
  });

  it("верхний уровень не объект — отдельная формулировка", () => {
    expect(FORMATS.json.validate("[]").reason).toBe("на верхнем уровне не объект");
    expect(FORMATS.json.validate("null").reason).toBe("на верхнем уровне не объект");
  });

  it("слово json остаётся в инструкции: без него DeepSeek отклоняет response_format", () => {
    expect(FORMATS.json.instruction).toContain("json");
  });
});

describe("yaml", () => {
  it("принимает ответ по контракту", () => {
    expect(FORMATS.yaml.validate(validYaml)).toEqual({ ok: true });
  });

  it("обёртка в markdown-блок проваливает разбор так же, как у json", () => {
    const result = FORMATS.yaml.validate(`\`\`\`yaml\n${validYaml}\n\`\`\``);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("не разбирается как YAML");
  });

  it("свободный текст разбирается в строку и проваливает контракт", () => {
    expect(FORMATS.yaml.validate("просто ответ одной строкой").reason).toBe("на верхнем уровне не объект");
  });

  it("проверяет items, а не только присутствие ключей", () => {
    expect(FORMATS.yaml.validate("summary: итог\nitems: 5").reason).toBe("items: ожидался массив");
  });
});

describe("md", () => {
  it("принимает ответ с обоими заголовками", () => {
    expect(FORMATS.md.validate("## Кратко\nитог\n\n## Пункты\n1. **первый** — много")).toEqual({ ok: true });
  });

  it("перечисляет недостающие заголовки", () => {
    expect(FORMATS.md.validate("## Кратко\nитог").reason).toBe("нет заголовков: ## Пункты");
    expect(FORMATS.md.validate("текст").reason).toBe("нет заголовков: ## Кратко, ## Пункты");
  });
});

describe("text", () => {
  it("формат не навязывается и любой ответ проходит", () => {
    expect(FORMATS.text.instruction).toBe("");
    expect(FORMATS.text.validate("")).toEqual({ ok: true });
  });
});
