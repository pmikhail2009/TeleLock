# TeleLock

Управление поиском матча в Deadlock через Telegram и уведомления о найденном матче. В интерфейсе и внутренних именах проект пока называется KATKA.

## Актуальная версия

- `mod/` — исходники игрового мода Panorama, HTML-панель, сборщик и тесты.
- `gateway/` — Cloudflare Worker, привязки, команды, роли, настройки и уведомления.
- `serverless/` — обработчики Telegram Serverless, схема данных и подготовка конфигурации.
- `tools/configure-access.mjs` — создание собственных паролей и хешей ролей.
- `server/` — резервный сервер на Node.js с SQLite.
- `katka_bot/`, `katka.py`, `assets/images/` — прежний Python-бот с распознаванием кнопок на экране.

Telegram позволяет подключить игру по одноразовому коду, запускать обычный, ранговый и уличный режимы, проверять состояние, управлять оповещениями. Часть команд зависит от роли. Мод использует сигналы Panorama для подтверждения поиска и состояния очереди.

## Собственное развёртывание

Нужен Node.js 24. Для Telegram Serverless установите зависимости: `npm ci --prefix serverless`.

1. Создайте своего Telegram-бота и приложение Telegram Serverless. Выполните вход через установленную CLI: `serverless/login.cmd`.
2. Создайте свой Cloudflare Worker по `gateway/wrangler.jsonc`. Через настройки Worker задайте секреты `KATKA_BOT_TOKEN`, `KATKA_APP_TOKEN` и `KATKA_CLOUD_SECRET`. Общий секрет — 32 случайных байта в hex (64 символа); он должен совпадать в Worker и Telegram Serverless.
3. Задайте переменную Worker `KATKA_PANEL_ORIGIN`: точный HTTPS origin своей панели без пути и завершающего слеша. Личные адреса предыдущей установки в исходниках отсутствуют.
4. В своём окружении задайте `KATKA_GATEWAY` (HTTPS origin Worker) и `KATKA_CLOUD_SECRET`, затем выполните `node serverless/configure.mjs`. Команда создаст локальные `serverless/tgcloud/lib/config.js` и `serverless/dist/index.html`; эти файлы содержат настройки развёртывания и исключены из Git.
5. Опубликуйте обработчики и статическую панель через CLI Telegram Serverless. `serverless/tgcloud/schema.js` задаёт структуру таблиц; данные существующих привязок не поставляются.
6. При необходимости выполните `node tools/configure-access.mjs` и загрузите только хеши из локального `build/access/worker-secrets.json` в секреты Worker `KATKA_OWNER_PASSWORD_HASH` и `KATKA_TEST_PASSWORD_HASH`. Пароли остаются локальными.
7. Для сборки игрового мода используйте `mod/build.ps1` с обязательными параметрами `PanelUrl`, `GameDirectory`, `Viewer` и `Modlock`, указывающими на вашу панель, игру и инструменты сборки. Скрипт создаёт VPK в `mod/build/`; готовые архивы не включены в репозиторий.
8. После установки мода получите новый код командой `/code` в своём боте и введите его в игровом меню. Личная привязка создаётся заново.

При изменении исходников Telegram runtime обновите встроенный модуль командой `node gateway/build-tgcloud-runtime.mjs` перед публикацией Worker.

## Проверки

Из корня проекта: `node --experimental-vm-modules --test mod/*.test.mjs gateway/*.test.mjs server/*.test.mjs serverless/test/*.test.mjs`.

Тесты используют вымышленные идентификаторы, пароли и адреса; рабочий Telegram и игра не требуются.

## Резервные варианты

Локальный сервер: задайте `TELEGRAM_BOT_TOKEN`, `KATKA_PANEL_ORIGIN`, при необходимости `KATKA_HOST`, `KATKA_PORT`, `KATKA_DATABASE` и запустите `node server/main.mjs`. SQLite создаётся локально и исключена из Git. Для контейнера используйте `server/Dockerfile`, передавая настройки при запуске.

Прежний Python-бот: Windows, Python 3.12, зависимости из `requirements.txt`; создайте локальный `.env` по пустому `.env.example`, задайте собственные токен и chat_id, запустите `python -m katka_bot`. Deadlock нужно запустить вручную. Распознавание чёрного экрана — косвенный признак загрузки матча.

## Что отсутствует в репозитории

Ключи и токены, личные Telegram/chat/user ID, коды и данные привязки компьютера, базы, пароли и их рабочие хеши, CLI-сессии, настройки действующего развёртывания, журналы, кэши, резервные копии, зависимости и готовые VPK. Пустые примеры и реализация механизма привязки включены, личные данные привязки — нет.
