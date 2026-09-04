import type OpenAI from "openai";
import { ask, type AskResult } from "./ask.js";
import { RAW_OPTIONS, type ResponseOptions } from "./options.js";
import { META_INSTRUCTION, type StrategyName } from "./strategies.js";

/** Несёт цену уже сделанных вызовов: у meta первый вызов оплачен, даже когда упал второй. */
export class StrategyError extends Error {
  constructor(
    message: string,
    readonly spentTokens: number,
    readonly elapsedMs: number,
  ) {
    super(message);
  }
}

export interface SolveResult {
  strategy: StrategyName;
  /** Итоговый вызов: из него ответ, finish_reason и проверка формата. */
  final: AskResult;
  /** Только у meta: вызов, сочинивший промпт. */
  preparation: AskResult | null;
  /** Сгенерированный промпт; в history не попадает. */
  generatedPrompt: string | null;
  /** Значение из строки FINAL, null — строки не нашлось. */
  finalValue: string | null;
  /** Задан ли эталон: без него null в hit означает «не мерили», а не «не извлеклось». */
  measured: boolean;
  /** Сумма по всем вызовам способа — его полная цена. */
  totalTokens: number;
  elapsedMs: number;
  /** null — точность не измерялась либо итог не извлёкся. */
  hit: boolean | null;
}

const FINAL_LINE = /^[ \t]*FINAL:[ \t]*(.+?)[ \t]*$/gim;

/** Берётся последнее совпадение: у experts маркер мелькает в репликах до итога. */
export function extractFinal(answer: string): string | null {
  const matches = [...answer.matchAll(FINAL_LINE)];

  return matches.at(-1)?.[1] ?? null;
}

/** Крайняя пунктуация и регистр значения не меняют: «Даша.» и «Даша» — один ответ. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:!?"'«»()[\]—–-]+|[\s.,;:!?"'«»()[\]—–-]+$/g, "");
}

/**
 * Сверяется итог целиком, а не подстрокой: «не Даша» содержит «Даша» и по подстроке засчиталось бы
 * как верный ответ. Ложный промах виден в напечатанном ответе, ложное попадание — нет.
 */
export function matchesExpected(final: string, expect: string[]): boolean {
  const normalized = normalize(final);

  return expect.some((variant) => normalized === normalize(variant));
}

/**
 * Один способ рассуждения целиком: обычно это один вызов API, у meta — два.
 * Историю дописывает вызывающий, причём исходным вопросом, а не сгенерированным промптом.
 */
export async function solve(
  client: OpenAI,
  model: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  question: string,
  options: ResponseOptions,
  expect: string[] | null,
): Promise<SolveResult> {
  const started = Date.now();

  let preparation: AskResult | null = null;
  let generatedPrompt: string | null = null;
  let final: AskResult;

  try {
    if (options.strategy === "meta") {
      // Промпт сочиняется свободным текстом: формат, лимит слов и FINAL описывают ответ, не его.
      // История нужна и здесь: без неё уточняющий вопрос породит промпт без предмета.
      preparation = await ask(
        client,
        model,
        history,
        question,
        {
          ...RAW_OPTIONS,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          thinkingEnabled: options.thinkingEnabled,
        },
        META_INSTRUCTION,
      );

      generatedPrompt = preparation.answer.trim();

      if (generatedPrompt.length === 0) {
        throw new Error(`Модель не вернула промпт (finish_reason: ${preparation.finishReason}), решать нечего.`);
      }

      // Задача остаётся пользовательским сообщением: промпт может ссылаться на неё словами
      // «приведённая задача», и подстановка его вместо вопроса оставила бы вызов без условия.
      final = await ask(client, model, history, question, options, generatedPrompt);
    } else {
      final = await ask(client, model, history, question, options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new StrategyError(message, preparation?.totalTokens ?? 0, Date.now() - started);
  }

  const finalValue = extractFinal(final.answer);
  const hit = expect === null || finalValue === null ? null : matchesExpected(finalValue, expect);

  return {
    strategy: options.strategy,
    final,
    preparation,
    generatedPrompt,
    finalValue,
    measured: expect !== null,
    totalTokens: final.totalTokens + (preparation?.totalTokens ?? 0),
    elapsedMs: Date.now() - started,
    hit,
  };
}
