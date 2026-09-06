import { describe, expect, it } from "vitest";
import { extractFinal } from "../src/solve.js";

describe("extractFinal", () => {
  it("возвращает null, если строки FINAL нет", () => {
    expect(extractFinal("Просто ответ без итога.")).toBeNull();
  });

  it("извлекает значение единственной строки FINAL", () => {
    expect(extractFinal("Рассуждение...\nFINAL: 42")).toBe("42");
  });

  it("берёт последнее совпадение, если FINAL встречается несколько раз", () => {
    const answer = "FINAL: Аня\nЕщё рассуждение...\nFINAL: Даша";
    expect(extractFinal(answer)).toBe("Даша");
  });
});
