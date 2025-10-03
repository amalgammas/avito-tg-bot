# Avito Telegram Bot

Telegram-бот на NestJS, который обрабатывает сообщения пользователей и ходит в Avito API по OAuth2 (client_credentials). Проект развивается для селлеров, которым нужно автоматизировать работу с Avito и другими маркетплейсами.

## Возможности
- Эхо-бот с командами `/start` и `/help` на базе `nestjs-telegraf`.
- Переключение режима работы бота по переменной `NODE_ENV`: polling в development, webhook в production.
- Сервис `AvitoApiService` с автоматическим получением и кешированием access token.
- Эндпоинт здоровья `GET /health` (возвращает `{ "status": "ok" }`).
- Dockerfile для сборки и запуска приложения.
- CI/CD в GitHub Actions — сборка TypeScript и публикация Docker-образа в GHCR.

## Структура проекта
```
apps/
  bot-api/
    src/
      bot/           # Обработчики Telegram-обновлений
      config/        # Конфигурация приложения и Avito API сервис
      health/        # Health-check контроллер
infra/
  Dockerfile         # Многостадийный образ на Node 20 + Yarn
.github/workflows/
  ci.yml             # Сборка, тесты и публикация образа в GHCR
.env.example         # Шаблон переменных окружения
package.json         # Скрипты и зависимости (Yarn 1)
yarn.lock            # Лок-файл Yarn 1
```

## Требования
- Node.js 20+
- Yarn 1 (устанавливается автоматически: `corepack enable` или поставляется в Node 20)
- Docker (для сборки образа)

## Установка зависимостей
```bash
yarn install --frozen-lockfile
```

## Конфигурация окружения
1. Скопируйте шаблон `.env.example` в `.env`:
   ```bash
   cp .env.example .env
   ```
2. Заполните переменные:
   - `TELEGRAM_BOT_TOKEN` — токен Telegram-бота (DEV/PROD).
   - `WEBHOOK_DOMAIN`, `WEBHOOK_PATH` — обязательны только в production (используются для запуска бота через webhook).
   - `AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET` — OAuth2 client credentials для Avito API.
   - При необходимости отредактируйте `PORT`, `AVITO_AUTH_URL`, `AVITO_API_BASE_URL`.

> **Важно:** файл `.env` не должен коммититься в репозиторий. Храните реальные токены в безопасном месте.

## Запуск в development
```bash
# NODE_ENV=development берётся из .env
yarn start:dev
```
Бот стартует в режиме long polling. После запуска отправьте `/start` или `/help` в Telegram-бот — вы получите ответ.

## Сборка и запуск production-сборки
```bash
# Компиляция TypeScript
yarn build

# Запуск собранного кода
NODE_ENV=production node dist/apps/bot-api/main.js
```
В production обязательно задайте `WEBHOOK_DOMAIN` и `WEBHOOK_PATH`, чтобы `nestjs-telegraf` поднял webhook на Cloudflare/вашем ingress.

## Docker
```bash
# Сборка образа
docker build -f infra/Dockerfile -t avito-bot .

# Запуск контейнера (пример)
docker run --rm \
  -e NODE_ENV=production \
  -e TELEGRAM_BOT_TOKEN=... \
  -e WEBHOOK_DOMAIN=https://example.com \
  -e WEBHOOK_PATH=/telegram \
  -e AVITO_CLIENT_ID=... \
  -e AVITO_CLIENT_SECRET=... \
  -p 3000:3000 \
  avito-bot
```

## GitHub Actions
Workflow `.github/workflows/ci.yml` запускается на каждом push/PR:
1. Устанавливает Node.js 20.
2. Кеширует зависимости Yarn.
3. Ставит зависимости (`yarn install --frozen-lockfile`).
4. Собирает TypeScript (`yarn build`).
5. Авторизуется в GHCR и собирает Docker-образ по `infra/Dockerfile`.
6. Публикует теги `ghcr.io/<repo>/bot-api:latest` и `ghcr.io/<repo>/bot-api:<commit_sha>` при пушах в `main`.

## Дальнейшие шаги
- Реализовать интеграцию с Avito API поверх `AvitoApiService` (конкретные эндпоинты, обработка ошибок, ретраи).
- Настроить webhook-приём за Cloudflare в production (домен, TLS, обратный прокси).
- Добавить рабочий контур деплоя на VPS/Render/Fly.
- Расширить обработчики Telegram, чтобы собирать данные пользователей и запускать бизнес-алгоритмы (например подбор таймслотов Ozon).
- Подготовить тесты (unit/e2e) и мониторинг (healthchecks, логирование, алерты).

## Полезные команды
- `yarn start:dev` — запуск в development.
- `yarn build` — компиляция TypeScript в `dist/`.
- `yarn start` — запуск собранного кода из `dist/`.

## Связь
- Telegram-бот: см. токен в `.env`.
- Репозиторий GitHub: `AntonMotorin/avito` (доступ по SSH-ключу `amalgammas`).
