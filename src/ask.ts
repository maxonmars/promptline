import type OpenAI from "openai";
import { FORMATS, type FormatName, type ValidationResult } from "./formats.js";
import { buildSystemPrompt, type ResponseOptions } from "./options.js";

export interface AskResult {
  answer: string;
  format: FormatName;
  completionTokens: number;
  /** У reasoning-моделей рассуждение тратит тот же лимит, что и ответ. */
  reasoningTokens: number;
  totalTokens: number;
  finishReason: string;
  stopMarker: string | null;
  temperature: number | null;
  thinkingEnabled: boolean;
  validation: ValidationResult;
}

/** thinking — DeepSeek-специфичное поле запроса, которого нет в типах openai SDK. */
type DeepSeekParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: "disabled" };
};

/**
 * Историю не трогает: системное сообщение подставляется в голову на каждый запрос, чтобы
 * переключение режима действовало сразу. Дописывать реплики в history — забота вызывающего.
 * extraSystem — дополнительный системный блок: так у meta сгенерированный промпт не занимает
 * место пользовательского сообщения, которое остаётся за самой задачей. Порядок блоков —
 * за buildSystemPrompt.
 */
export async function ask(
  client: OpenAI,
  model: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  question: string,
  options: ResponseOptions,
  extraSystem?: string,
): Promise<AskResult> {
  const params: DeepSeekParams = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(options, extraSystem) },
      ...history,
      { role: "user", content: question },
    ],
  };

  // max_tokens помечен в SDK как deprecated в пользу max_completion_tokens, но DeepSeek ждёт его.
  if (options.maxTokens !== null) params.max_tokens = options.maxTokens;
  if (options.stopMarker !== null) params.stop = [options.stopMarker];
  if (options.temperature !== null) params.temperature = options.temperature;
  if (options.format === "json") params.response_format = { type: "json_object" };
  // По умолчанию thinking mode включён и API его не спрашивает — поле нужно только чтобы выключить.
  if (!options.thinkingEnabled) params.thinking = { type: "disabled" };

  const response = await client.chat.completions.create(params);
  const choice = response.choices[0];
  const answer = choice?.message?.content ?? "";

  return {
    answer,
    format: options.format,
    completionTokens: response.usage?.completion_tokens ?? 0,
    reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    finishReason: choice?.finish_reason ?? "неизвестно",
    stopMarker: options.stopMarker,
    temperature: options.temperature,
    thinkingEnabled: options.thinkingEnabled,
    validation: FORMATS[options.format].validate(answer),
  };
}
