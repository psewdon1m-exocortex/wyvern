# Wyvern

Wyvern — общий LLM gateway хоста Exocortex. Сервисы с LLM-функциями устанавливают его через Updater или подключаются к совместимому установленному экземпляру. Основная сущность — настроенный Adapter, который сервис выбирает в Settings.

Текущий этап — разработка версии 0.0.1. Реализованы runtime, CLI, Google driver, streaming, загрузка конфигурации через Kernel/Volt и диагностика/управление в общей TUI Updater. Автоматическая установка через Updater, редактирование Adapter, карточки потребителей и медиа ещё требуют реализации и приёмки. Подробности и результаты проверок: [IMPLEMENTATION](docs/IMPLEMENTATION.md), [API](docs/api.md), [принятые решения](docs/decisions.md).

- [Актуальный план интеграции v0.2](wyvern-integration-plan-v0.2.md) учитывает решения владельца от 19 сентября 2026 года, общую TUI и существующие Kernel/Volt/Updater.
- [Исходная спецификация v0.1](wyvern-spec-v0.1.md) сохраняет исходные требования и примеры; её модель Route-first и интеграционные разделы подлежат переработке по плану v0.2.

Общие контракты Exocortex определены в [.docs / Part 00](../.docs/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md). План отмечает необходимые расширения этих контрактов, но сам не меняет существующие API, разрешения или правила релизов.

Проверка: `npm ci`, затем `npm run check`. Linux-проверка с Unix sockets: `docker build --target verification -t wyvern-verification:local .`. Это локальный проверочный образ, а не опубликованный релиз.
