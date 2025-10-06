# Ozon Telegram Bot

Telegram-бот на NestJS, который помогает селлерам автоматизировать работу с API Ozon (client_id + api_key). В ближайших итерациях он будет отслеживать появление таймслотов и бронировать поставки автоматически.

## Возможности
- Диалог с пользователем через Telegram (nestjs-telegraf), команды `/start`, `/help`, `/ping`, `/time`, эхо-фраза «привет».
- Переключение режима работы: `NODE_ENV=development` — polling, `NODE_ENV=production` — webhook (Cloudflare).
- Сервис `OzonApiService` с логированием, ретраями и подстановкой `Client-Id`/`Api-Key` из `.env` или введённых пользователем данных.
- Проверка пользовательских Ozon-ключей прямо из бота (`/ozon_auth`, `/ozon_keys`, `/ozon_clear`).
- Эндпоинт здоровья `GET /health` (возвращает `{ "status": "ok" }`).
- Dockerfile для сборки и запуска приложения.
- CI/CD в GitHub Actions — сборка TypeScript и публикация Docker-образа в GHCR.

## Структура проекта
```
apps/
  bot-api/
    src/
      bot/           # Telegram-обработчики и временное хранилище ключей
      config/        # Конфигурация приложения и Ozon API сервис
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
- Yarn 1 (входит в поставку Node 20 via Corepack)
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
   - `TELEGRAM_BOT_TOKEN` — токен Telegram-бота.
   - `WEBHOOK_DOMAIN`, `WEBHOOK_PATH` — обязательны только в production (для webhook).
   - `OZON_CLIENT_ID`, `OZON_API_KEY` — данные из личного кабинета Ozon.
   - `OZON_SUPPLY_SPREADSHEET_ID`, `OZON_SUPPLY_DROP_OFF_ID`, `OZON_SUPPLY_POLL_INTERVAL_MS` — настройки автоматизации поставок (Google Sheet, точка сдачи, частота проверки). Сейчас бот всегда использует crossdock.
   - При необходимости отредактируйте `PORT`, `OZON_API_BASE_URL`, параметры таймаутов/ретраев.

> **Важно:** файл `.env` не коммитьте в репозиторий. Реальные ключи храните в надёжном месте.

## Запуск в development
```bash
# NODE_ENV=development берётся из .env
yarn start:dev
```
Бот стартует в режиме long polling. После запуска отправьте `/start` или `/help` — получите ответ и список команд.

### Telegram-команды для работы с Ozon
- `/ozon_auth <CLIENT_ID> <API_KEY>` — сохранить ключи (хранятся только в оперативной памяти процесса).
- `/ozon_keys` — показать сохранённые ключи (маскированы).
- `/ozon_clear` — удалить сохранённые ключи.
- `/ozon_run [ссылка]` — запустить цикл опроса Google Sheets и автоматическое создание поставок (можно передать ссылку/ID конкретного файла).
- `/ozon_preview <ссылка>` — показать список задач и товаров из таблицы, не запуская цикл.
- `/ozon_clusters` — вывести список доступных кластеров/складов по текущим ключам.

## Сборка и запуск production-сборки
```bash
# Компиляция TypeScript
yarn build

# Запуск собранного кода
NODE_ENV=production node dist/apps/bot-api/main.js
```
В production обязательно задайте `WEBHOOK_DOMAIN` и `WEBHOOK_PATH`, чтобы `nestjs-telegraf` поднял webhook (например за Cloudflare).

## Docker
```bash
# Сборка образа
docker build -f infra/Dockerfile -t ozon-bot .

# Запуск контейнера (пример)
docker run --rm \
  -e NODE_ENV=production \
  -e TELEGRAM_BOT_TOKEN=... \
  -e WEBHOOK_DOMAIN=https://example.com \
  -e WEBHOOK_PATH=/telegram \
  -e OZON_CLIENT_ID=... \
  -e OZON_API_KEY=... \
  -p 3000:3000 \
  ozon-bot
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
- Реализовать сценарий поиска таймслотов: черновики поставок, проверка слотов, бронирование.
- Настроить webhook-приём за Cloudflare в production (домен, TLS, обратный прокси).
- Добавить рабочий контур деплоя на VPS/Render/Fly.
- Расширить бота (опрос данных пользователя, уведомления, платная подписка).
- Подготовить тесты (unit/e2e) и мониторинг (healthchecks, логирование, алерты).

## Полезные команды
- `yarn start:dev` — запуск в development.
- `yarn build` — компиляция TypeScript в `dist/`.
- `yarn start` — запуск собранного кода из `dist/`.

## Связь
- Telegram-бот: токен задаётся через `.env`.
- Репозиторий GitHub: `AntonMotorin/avito` (доступ по SSH-ключу `amalgammas`).
