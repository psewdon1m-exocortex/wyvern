# Wyvern

Wyvern — общий LLM gateway хоста Exocortex. Сервисы с LLM-функциями устанавливают его через Updater или подключаются к совместимому установленному экземпляру. Основная сущность — настроенный Adapter, который сервис выбирает в Settings.

Реализация 0.0.1 и интеграции с Kernel, Volt, Updater, Mastermind и Laboratory завершены в рабочем пространстве. Это неопубликованный кандидат: подписанный выпуск и проверка на реальном хосте выполняются отдельно. Реализованы управление Adapter в общей TUI, установка и обновление через Updater, Settings потребителей, Google text/JSON/SSE и медиа. [Установка и эксплуатация](docs/operations.md), [результаты проверок и порядок выпуска](docs/IMPLEMENTATION.md), [API](docs/api.md), [принятые решения](docs/decisions.md).

- [Актуальный план интеграции v0.2](wyvern-integration-plan-v0.2.md) учитывает решения владельца от 19 сентября 2026 года, общую TUI и существующие Kernel/Volt/Updater.
- [Исходная спецификация v0.1](wyvern-spec-v0.1.md) сохраняет исходные требования и примеры; её модель Route-first и интеграционные разделы подлежат переработке по плану v0.2.

Общие контракты Exocortex определены в [Part 00](https://github.com/psewdon1m-exocortex/general/blob/main/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md). Реализованный профиль Wyvern описан в Parts 09–10; правила подписи и приёмки релизов сохраняются.

Проверка: `npm ci`, затем `npm run check`. Linux-проверка с Unix sockets: `docker build --target verification -t wyvern-verification:local .`. Это локальный проверочный образ, а не опубликованный релиз.

Подписанный выпуск требует отдельного отчёта для точного коммита: [контракт приёмки и выпуск](docs/releasing.md).
