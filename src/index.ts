import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import OpenAI from "openai";

const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  console.error("Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.");
  process.exit(1);
}

const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

// DeepSeek отдаёт OpenAI-совместимый API — хватает подмены baseURL в официальном SDK.
const client = new OpenAI({
  apiKey,
  baseURL: "https://api.deepseek.com",
});

const history: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: "system", content: "Ты полезный ассистент. Отвечай кратко и по делу." },
];

let totalTokens = 0;

/** Отправляет вопрос вместе со всей историей и дописывает ответ в неё же. */
async function ask(question: string): Promise<string> {
  history.push({ role: "user", content: question });

  const response = await client.chat.completions.create({ model, messages: history });
  const answer = response.choices[0]?.message?.content ?? "(пустой ответ)";

  history.push({ role: "assistant", content: answer });
  totalTokens += response.usage?.total_tokens ?? 0;

  return answer;
}

const argvPrompt = process.argv.slice(2).join(" ").trim();

if (argvPrompt) {
  console.log(`\nЗапрос: ${argvPrompt}`);
  console.log(`Модель: ${model}\n`);

  try {
    const answer = await ask(argvPrompt);
    console.log("Ответ:");
    console.log(answer);
    console.log(`\n— израсходовано токенов: ${totalTokens}`);
  } catch (error) {
    console.error("Запрос не удался:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Без этого Ctrl+C во время ввода не закрывает интерфейс, и процесс висит.
  rl.on("SIGINT", () => rl.close());

  console.log(`Модель: ${model}. Выход — «выход», Ctrl+C или Ctrl+D.\n`);
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const question = line.trim();

    if (!question) {
      rl.prompt();
      continue;
    }

    if (["выход", "exit", "quit"].includes(question.toLowerCase())) break;

    try {
      console.log(`\n${await ask(question)}\n`);
    } catch (error) {
      // Одна неудачная реплика не должна ронять сессию — вопрос убираем из истории.
      history.pop();
      console.error(`\nЗапрос не удался: ${error instanceof Error ? error.message : error}\n`);
    }

    rl.prompt();
  }

  rl.close();
  console.log(`\n— израсходовано токенов за сессию: ${totalTokens}`);
}
