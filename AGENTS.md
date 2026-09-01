# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Что это

`promptline` — CLI для диалога с LLM через DeepSeek API. Один файл, два режима: с аргументом —
один вопрос и выход, без аргумента — интерактивный диалог через `node:readline/promises`.
Тестов, линтера и CI нет.

## Команды

```bash
npm install
npm run dev                              # интерактивный диалог
npm run dev -- "свой вопрос"             # один вопрос; -- обязателен, иначе npm съест аргументы
npm run build && npm start               # tsc в dist/, затем node dist/index.js
```

Нужен Node.js 20+ и `.env` с `DEEPSEEK_API_KEY` (шаблон — `.env.example`).

## Архитектура

DeepSeek отдаёт API, совместимый с OpenAI, поэтому используется официальный пакет `openai`
с подменённым `baseURL` на `https://api.deepseek.com`. Модели задаются строкой в
`DEEPSEEK_MODEL`: `deepseek-v4-flash` (по умолчанию) или `deepseek-v4-pro`.

Массив `history` копится в памяти и уходит в API целиком на каждой реплике — это и даёт
контекст диалога, и линейно удорожает длинную сессию. Ошибка запроса не роняет цикл: реплика
выкидывается из `history`, чтобы там не осталось вопроса без ответа.

ESM: `"type": "module"` + `module: "nodenext"`. Top-level `await` используется напрямую,
относительные импорты внутри проекта потребуют расширения `.js`.
