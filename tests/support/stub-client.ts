import type OpenAI from "openai";

export type Params = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: "disabled" };
};

export interface Reply {
  content?: string | null;
  finishReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Ответ без choices и без usage: так выглядит вырожденный ответ API. */
  bare?: boolean;
}

export interface Stub {
  client: OpenAI;
  /** Параметры каждого вызова в порядке отправки. */
  calls: Params[];
}

function completion(reply: Reply): OpenAI.Chat.ChatCompletion {
  if (reply.bare) return { choices: [] } as unknown as OpenAI.Chat.ChatCompletion;

  return {
    choices: [{ message: { content: reply.content ?? "" }, finish_reason: reply.finishReason ?? "stop" }],
    usage: {
      completion_tokens: reply.completionTokens ?? 0,
      total_tokens: reply.totalTokens ?? 0,
      completion_tokens_details: { reasoning_tokens: reply.reasoningTokens ?? 0 },
    },
  } as unknown as OpenAI.Chat.ChatCompletion;
}

/** Клиент с заготовленными ответами по порядку вызовов; Error в списке роняет соответствующий вызов. */
export function stubClient(replies: (Reply | Error)[]): Stub {
  const calls: Params[] = [];
  let index = 0;

  const create = async (params: Params): Promise<OpenAI.Chat.ChatCompletion> => {
    calls.push(params);

    const reply = replies[index];
    index += 1;

    if (reply === undefined) throw new Error(`Вызов ${index}: заготовлено ответов ${replies.length}.`);
    if (reply instanceof Error) throw reply;

    return completion(reply);
  };

  return { client: { chat: { completions: { create } } } as unknown as OpenAI, calls };
}

/** Системное сообщение вызова: оно подставляется в голову на каждый запрос. */
export function systemOf(params: Params): string {
  const first = params.messages[0];

  if (first?.role !== "system" || typeof first.content !== "string") {
    throw new Error("Первым сообщением ожидался системный блок строкой.");
  }

  return first.content;
}
