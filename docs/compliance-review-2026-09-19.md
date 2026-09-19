# Проверка соответствия Wyvern требованиям `.docs`

Дата: 2026-09-19. Итог: **полного соответствия нет; проект нельзя считать завершённым по Definition of Done из Parts 00 и 06**. Функциональная реализация и интеграционные тесты есть, но остаются нарушения обязательных требований к релизу, эксплуатации и интеграциям.

Это аудит исходников и доступных локальных проверок, а не release qualification. Он не разрешает публикацию или production rollout. В рамках аудита добавлен только этот отчёт; код, центральные требования и рабочие установки не изменялись.

## Основание и область проверки

Проверены применимые требования Parts 00–12, Wyvern и непосредственно связанные с ним участки Updater, Kernel, Volt, Mastermind и Laboratory. Полный аудит остальных функций этих проектов не проводился. Центральные требования использованы в их текущей версии, включая новые правила Settings и сохранение functional connection intent в backup.

| Репозиторий | Проверенная ревизия |
| --- | --- |
| `.docs` | `8737b50f0aca4b84f4fa223272bdfb63ade05d33` |
| Wyvern | `c443a18003814d348d05ccd24ecf2ec2e957513b` |
| Updater | `ab54fef84b3b3b64913a322fd016fa4bf4ea6dc0` |
| Kernel | `be66199b871d02bca3b245b58f8294d261e04c32` |
| Volt | `0ba0f286b820ae65cc3fff5b6a3395f204d5ee70` |
| Mastermind | `ce2793ff7ddf63678c3910b8c16b31de3af543bd` |
| Laboratory | `4196169ea3a31e57ef7a0d6b1cd2985db302d99d` |

Статусы ниже описывают проверенную область, а не заменяют поэлементный протокол приёмки. `PARTIAL` означает наличие реализации при незакрытых требованиях; `FAIL` — подтверждённое нарушение; `NOT_RUN` — отсутствие выполненной проверки. Процент соответствия не рассчитывался.

| Требования | Применимость и результат |
| --- | --- |
| [Part 00](../../.docs/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md), применимость, документация, pre-push, завершение | **FAIL**: нет единого обязательного pre-push gate и полного актуального протокола применимости; формулировка завершения завышена. W04, W10. |
| [Part 01](../../.docs/PART_01_INTERFACE_AND_INTERACTION_UNIFICATION.md), TUI, Settings, Initialize | **PARTIAL**: TUI и отдельные карточки реализованы; текущий web workflow и обязательная матрица приёмки не закрыты. W08. |
| [Part 02](../../.docs/PART_02_OBSERVABILITY_AUDIT_AND_LOG_EXPORT.md), аудит, redaction, retention | **FAIL**: нет обеспеченной ротации контейнерного потока и части обязательных security events; нет age retention в файловом аудите. W02, W06. |
| [Part 03](../../.docs/PART_03_BACKUP_AND_RECOVERY.md), логическое состояние и восстановление | **PARTIAL**: есть механизм host recovery; scoped Adapter/function intent не входит в backup потребителей. Полный реальный host round trip не выполнен. W09. |
| [Part 04](../../.docs/PART_04_BOOTSTRAP_AND_DEPLOYMENT.md), bootstrap и контейнер | **PARTIAL**: подписанный bootstrap, Updater-first и ограничения контейнера реализованы; требования к логам не закрыты. Реальная чистая установка здесь не проверена. W02. |
| [Part 05](../../.docs/PART_05_CI_RELEASES_AND_LOCAL_UPDATES.md), выпуск и обновление | **FAIL**: обычный релиз публикуется до финального gate; не завершена квалификация точного набора артефактов и supply chain. W01, W03, W05. |
| [Part 06](../../.docs/PART_06_UNIFIED_ACCEPTANCE_CHECKLIST.md), общий acceptance и Definition of Done | **FAIL**: проходящие локальные тесты не заменяют обязательные проверки и evidence. W04, W08–W10. |
| [Part 07](../../.docs/PART_07_SECURITY_AND_EXPOSURE_CONTROL.md), CI, секреты, exposure | **PARTIAL / FAIL по обязательным пунктам**: scoped identities и разделение admin/data есть; signing isolation, supply chain и remote health требуют исправлений. W03–W07. |
| [Part 08](../../.docs/PART_08_SEO_AND_GEO.md), публичный SEO/GEO | **N/A для indexable-страниц самого Wyvern**: таких страниц нет. Provider interface применим к интеграции Laboratory; SEO всего Laboratory этим аудитом не сертифицируется. |
| [Part 09](../../.docs/PART_09_SERVICE_AGENTS_DEPLOYMENT_AND_LIFECYCLE.md), общий gateway и lifecycle | **PARTIAL**: архитектура соответствует принятому Wyvern extension; реальная host-квалификация и связанные релизные требования не закрыты. |
| [Part 10](../../.docs/PART_10_SERVICE_AGENTS_UI_AND_OPERATOR_WORKFLOWS.md), операторские сценарии | **PARTIAL**: scoped Adapter selection есть; Initialize, возобновление наблюдения и компонентный update UI не завершены. W08. |
| [Part 11](../../.docs/PART_11_INITIAL_MULTI_SERVICE_DEPLOYMENT.md), конкретная начальная топология | **N/A как прямой профиль Wyvern**: перечисленная начальная топология не включает Wyvern. Общие требования зависимостей остаются применимыми через остальные Parts. |
| [Part 12](../../.docs/PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md), known-problem gate | **PARTIAL, квалификация NOT_RUN**: валидатор receipt есть, но финальный gate расположен после публикации; текущего полного отчёта для этого candidate нет. W01, W04, W05. |

## Подтверждённые замечания

Приоритеты: P1 — устранить до поддерживаемого релиза/эксплуатации; P2 — обязательный пробел, который также мешает объявить полное соответствие. Это приоритет исправления, а не утверждение, что описанный инцидент уже произошёл.

### W01 — P1. Неквалифицированный релиз доступен установщику

**Где:** [release.yml](../.github/workflows/release.yml), строки 113–117; [Updater release selection](../../updater/internal/release/release.go), строки 74–85; [Wyvern update](../../updater/internal/component/wyvern_release.go), строки 48–54.

`gh release create ... --latest=false` создаёт обычный релиз, затем запускается `verify-published.py`, и только позже загружается итоговый отчёт. Updater исключает draft/prerelease и выбирает stable-версию; отсутствие отметки latest не закрывает доступ. Если финальная проверка упадёт, подписанный installable release уже останется доступным. Возможна установка до завершения проверки.

**Требования:** Part 05 §§25.2, 25.5; Part 07 §44.3; обязательный gate Part 12.

**Что изменить:** квалифицировать артефакты в staging или prerelease, который исключён из discovery, и только после успешного финального gate переводить релиз в поддерживаемое состояние. Для anonymous-download проверки нужен доступный staging/prerelease; одного приватного draft недостаточно. Прямой bootstrap/manifest install должен также отвергать неквалифицированный candidate либо использовать отдельный канал staging.

**Критерий закрытия:** искусственный сбой проверки assets не оставляет версию доступной ни через discovery, ни через поддерживаемую прямую установку; успешная публикация происходит после сохранения финального отчёта.

### W02 — P1. Production unit не обеспечивает ротацию stdout/stderr

**Где:** [wyvern_deployment.go](../../updater/internal/component/wyvern_deployment.go), строка 525; [bin/wyvern.js](../bin/wyvern.js), строка 59.

`docker run` не задаёт logging driver и лимиты `max-size`/`max-file` и не проверяет эквивалентную политику хоста. Wyvern регулярно пишет telemetry в stdout. Ограничение `writableLength` защищает память процесса, а ротация `operator.jsonl` — другой поток. На хосте без настроенной ротации Docker этот поток не имеет обеспеченного ограничения диска.

**Требования:** Part 02 §§10–11, особенно §11.3; Part 04 §21; Part 06 §36.

**Что изменить:** задать проверяемый контейнерный бюджет ротации и отдельный контракт для host journal. Базовый ориентир Part 02 — три файла по 10 MiB для обычного контейнерного потока; отклонение документировать.

**Критерий закрытия:** тест проверяет фактический `HostConfig.LogConfig` установленного контейнера; нагрузочная запись вызывает ротацию и не превышает заявленный бюджет. Заполнения диска на реальном хосте в этом аудите не наблюдали.

### W03 — P1. Signing key доступен дольше необходимого

**Где:** [release.yml](../.github/workflows/release.yml), строки 73–84 и 106–120; [fetch-updater.py](../scripts/fetch-updater.py), вызовы `subprocess.check_output`.

Приватный ключ появляется в environment и временном файле ещё до получения dependency bundle. `fetch-updater.py` запускает скачанный Updater для проверки версии/capabilities; дочерний процесс наследует `SIGNING_KEY`. Файл ключа затем сохраняется во время остальных операций, включая загрузку артефактов, и удаляется только заключительным cleanup. Это нарушает изоляцию даже при корректной проверке подписи самой зависимости.

**Требования:** Part 07 §§43.5, 44.2: минимальный интервал подписи и удаление ключа до artifact upload; разделение signing/upload permissions.

**Что изменить:** получать и проверять зависимости до инъекции signing secret; выделить минимальный этап подписи; удалить файл и очистить переменные до публикации. `always` cleanup оставить дополнительной защитой. Публичный trust pin можно проверять без предварительного раскрытия приватного ключа dependency-процессам.

**Критерий закрытия:** dependency/test/upload процессы не получают key environment или key file; ошибка подписи тоже гарантирует очистку. Фактическая утечка ключа этим аудитом не установлена.

### W04 — P2. Нет обязательного воспроизводимого pre-push gate

**Где:** [package.json](../package.json), scripts; [ci.yml](../.github/workflows/ci.yml); [check.mjs](../scripts/check.mjs); [development acceptance](acceptance-v0.0.1-dev.md).

`npm run check` проверяет JavaScript и тесты. В CI дополнительно есть packaging и container smoke, но отсутствует единая команда для семи обязательных областей с классификацией PASS/N/A на точную outgoing revision. Не найден версионируемый полный реестр exposure для маршрутов/listeners. Обычный CI не выполняет актуальный Part 12 catalog lint и полный машинно проверяемый набор затронутых требований. Общая таблица development acceptance этого не заменяет.

**Требования:** Part 00 §§4.1, 4.6; Part 06 §41.1; Part 05 §25.5; Part 07 §46; Part 12.

**Что изменить:** добавить одну команду, coverage/applicability record и exposure matrix; включить backup/restore, update/rollback, internal documentation, technical documentation, security и условные SEO/private-exposure проверки. CI должен повторять машинную часть, а неизвестная применимость блокировать gate.

**Критерий закрытия:** пропущенная область, устаревшая ревизия и неклассифицированный маршрут дают FAIL. Remote branch protection в этом аудите не проверялся; его отсутствие не утверждается.

### W05 — P2. Release evidence не связывает весь candidate; supply-chain проверки неполны

**Где:** [verify-qualification.py](../scripts/verify-qualification.py), строки 49–101; [release.yml](../.github/workflows/release.yml), строки 28–58 и 73–117; [build-release.py](../scripts/build-release.py).

Валидатор проверяет source SHA, tag, immutable catalog revision, состав ID и хеши evidence/logs. Это полезный контроль. Однако он не требует идентичности квалифицированного installer/manifest/image digest. Pre-signing validation запускается до сборки окончательного installer/manifest; dependency bundle поступает позже. Совпадение source SHA само по себе не доказывает, что receipt относится ко всему конечному набору артефактов.

Также в pipeline нет явной генерации и проверки SBOM/provenance attestations для выпускаемого OCI image, проверки final image layers и полного набора выходов на secrets/high-risk files. `upload-artifact@v4` и `download-artifact@v4` закреплены изменяемым тегом, тогда как другие actions закреплены SHA. В репозитории есть потребитель внешнего qualification artifact, но нет workflow, производящего полный такой отчёт; отсутствие этого внешнего входа правильно блокирует релиз, однако не доказывает завершённость процесса.

**Требования:** Part 05 §§25.2, 25.5; Part 07 §§43.4, 43.7, 44.1–44.3; Part 12.

**Что изменить:** сформировать точный candidate до pre-signing gate, привязать receipt к digest артефактов, dependency set и утверждённой policy revision; выпускать проверяемые SBOM/provenance, сканировать конечные выходы и закрепить actions SHA. Для signature-dependent файлов завершать отдельную финальную фазу.

**Критерий закрытия:** замена installer/image при неизменном source SHA отвергается; отсутствие attestation или обнаруженный секрет блокируют публикацию. Подмена артефактов в действующем CI не выполнялась.

### W06 — P2. Security audit и retention реализованы не полностью

**Где:** [audit.js](../src/audit.js), строки 7–42; [runtime.js](../src/runtime.js), строки 69–76; [server.js](../src/server.js), строки 90–99; [util.js](../src/util.js), строки 68–71.

Файловый audit принимает только `config_activated` и `drain_changed`. Ошибка authentication возникает до создания request operation; catch возвращает безопасный ответ, но не записывает security event. В локальном HTTP fixture запрос с неверным синтетическим токеном вернул `401 authentication_failed` и не добавил событий в telemetry sink. Код также не вызывает audit для этой ветки.

Файлы аудита ограничены размером и количеством, но не возрастом. Telemetry использует whitelist верхнего уровня, без обязательной централизованной рекурсивной redaction; у runtime-событий нет времени/уникального event ID. Последние поля относятся к рекомендованной схеме Part 02; отсутствие security events, age retention и recursive redaction — отдельные обязательные пробелы. Утечка реальных credentials не обнаружена.

**Требования:** Part 02 §§10.1–10.2, 11, 12.1.1; Part 06 §36; Part 07 §49.

**Что изменить:** писать безопасные события authentication/authorization/error и мутаций, в том числе при раннем отказе; ввести общий redactor и retention по count/age/bytes. Не включать токены, prompts или provider response bodies в audit.

**Критерий закрытия:** отказ доступа виден с outcome/correlation и без секрета; вложенные чувствительные значения удаляются; старые события очищаются независимо от достижения size limit.

### W07 — P2. Неаутентифицированный health раскрывает версию

**Где:** [server.js](../src/server.js), строки 22–24; [remote ingress example](operations.md), строки 42–58.

Health обрабатывается до проверки Bearer token. Реальный локальный HTTP probe без токена получил `200` и `{"service":"wyvern","version":"0.0.1","alive":true}`. Документированный remote Nginx location проксирует весь `/wyvern/`, включая этот endpoint.

**Требования:** Part 07 §45.4 запрещает раскрытие версии/topology неаутентифицированным callers.

**Что изменить:** оставить в unauthenticated health минимальный сигнал либо закрыть подробную диагностику авторизацией; описать и проверить разрешённые ingress routes.

**Критерий закрытия:** anonymous health не содержит версии или топологии; protected diagnostics недоступны без нужной identity. Это условная проблема remote-профиля: аудит не утверждает, что локальный UDS уже опубликован в интернете.

### W08 — P2. Карточки потребителей не реализуют текущий Settings workflow

**Где:** [Mastermind Settings](../../mastermind/src/mastermind/web/settings.js), строка 73; [Mastermind Wyvern card](../../mastermind/src/mastermind/web/wyvern.js), строки 24–52; [Laboratory card](../../laboratory/services/web/static/scripts/admin.js), строки 444–470; [Laboratory markup](../../laboratory/services/web/static/admin.html), строка 132.

Есть раздельные статусы, allowed Adapter selection, CAS и сохранение недоступного текущего выбора. Но заголовок — `Wyvern`, тогда как текущая норма требует `Wyverne Connection` без изменения protocol/repository identifiers. Отсутствуют требуемая группа версии/update и Initialize overlay с read-only preflight, стадиями и восстановлением наблюдения.

`Connect through Updater` сразу отправляет POST, показывает toast с job ID и перечитывает status. Job ID не сохраняется для reload/reconnect, нет наблюдения terminal result. [Mastermind connect](../../mastermind/src/mastermind/wyvern_routes.py), строки 26–32, и [Laboratory connect](../../laboratory/services/api/src/server.js), строки 556–559, создают новый request ID на каждый POST. Потерянный ответ нельзя разрешить повтором того же client operation ID.

**Требования:** Part 01 §§10.5.1, 10.5.6–10.5.7, 10.9; Part 10 §§8–9; Part 06 §38.1.

**Что изменить:** встроить общий Initialize/update UI, durable observation и стабильный operation ID; привести карточки к текущему контракту. Вопрос полномочий компонентного update согласовать с root-only управлением Wyvern из Part 09: web-процесс не должен получать host-admin socket или расширенные права только ради кнопки.

**Критерий закрытия:** reload/закрытие overlay не теряет accepted job; uncertain response не создаёт новую независимую операцию; все состояния и установленная Part 01 матрица ширин/zoom/coarse-pointer/keyboard проверены. Ранее записанные desktop/390px проверки не закрывают эту матрицу. Само наличие кнопки Apply не трактуется здесь как доказательство отсутствия любого явного подтверждения смены Adapter.

### W09 — P2. Backup потребителя не сохраняет его Adapter/function intent

**Где:** [Mastermind bindings route](../../mastermind/src/mastermind/wyvern_routes.py), строки 18–24; [Mastermind backup](../../mastermind/src/mastermind/backup.py), строки 153–192; [Laboratory bindings route](../../laboratory/services/api/src/server.js), строки 549–554; [Laboratory snapshot](../../laboratory/services/api/src/storage.js), строки 414–423; [Laboratory backup](../../laboratory/services/api/src/backup.js), строки 111–115.

Binding changes передаются Wyvern и хранятся в control plane. Логические архивы потребителей экспортируют собственные таблицы, но не получают и не сохраняют этот scoped intent. Поэтому backup приложения не фиксирует выбранный им Adapter/profile/function на момент снимка; восстановление на другой instance или после изменения control-plane binding не воспроизводит эту настройку из архива.

**Требования:** Part 03 §14.1 прямо включает non-secret scoped Adapter/function selection и binding intent. Исключение Part 09 для runtime rollback Wyvern не отменяет это требование к логическому backup потребителя.

**Что изменить:** включить только собственный non-secret intent с revision/provenance; определить восстановление с повторной проверкой enrollment, разрешений и capabilities. Секреты и чужие bindings не переносить; global Kernel/Volt rollback не выполнять.

**Критерий закрытия:** backup → изменение binding → restore в чистый совместимый instance возвращает собственный intent либо явное pending-verification состояние; чужие клиенты не меняются. Этот конкретный round trip пока не выполнен; нарушение установлено по export/mutation paths.

### W10 — P2. Документация не даёт согласованной картины готовности

**Где:** [IMPLEMENTATION.md](IMPLEMENTATION.md), строка 3; [decisions.md](decisions.md), строка 15; [Mastermind internal Documentation](../../mastermind/src/mastermind/documentation.py), строки 50–55, 94–96 и 118.

`IMPLEMENTATION.md` объявляет implementation complete, а decisions всё ещё говорит, что typed Updater lifecycle требует реализации. Development acceptance имеет полезные оговорки о fixture-only и внешних gates, но его PASS по областям нельзя читать как соответствие текущей центральной спецификации. Встроенная Documentation Mastermind описывает provider/model через прежнюю Kernel/Volt схему и не объясняет появившиеся Wyvern Settings и TUI.

**Требования:** Part 00 §§3–4, 6; Part 06 §§41.1–41.2: актуальная техническая и операторская документация, явные ограничения и проверяемый Definition of Done.

**Что изменить:** разделить статусы функционального source candidate, соответствия `.docs`, release qualification и deployment readiness; обновить внутреннюю Documentation и решения с учётом реализованного кода. Документация конкретного live-стенда должна отдельно обозначать его фактическую конфигурацию.

**Критерий закрытия:** оператор по актуальной встроенной Documentation может подключить gateway, выбрать Adapter, диагностировать отказ и понять границы backup/update; все утверждения о готовности имеют подходящее evidence.

## Проверки, выполненные в этом аудите

| Проверка | Результат |
| --- | --- |
| `docker build --quiet --target verification -t wyvern-compliance:local .` | PASS; image ID `sha256:18bbb60402c1d1d921854c6a2ef20fba8775580a8094f099f532e282dd93badf` |
| `docker run --rm --entrypoint npm wyvern-compliance:local test` | **32/32 PASS**, без пропусков |
| Linux/WSL: `python3 -m unittest discover -s packaging -p 'test_*.py'` | **11/11 PASS** |
| Linux/WSL, Updater: `go test ./internal/component ./internal/hostrecovery` | PASS; hostrecovery использовал Go test cache |
| `node scripts/verify-workspace.mjs C:\.projects\exocortex` | PASS: настоящая HTTP-цепочка Wyvern → Kernel → Volt с отдельным временным состоянием и синтетическим provider; ротация ключа и отказ legacy identity |
| HTTP fixture из `tests/helpers.js`: неверный Bearer token | `401 authentication_failed`, `new_events: []` |
| Тот же fixture: `/health/live` без токена | `200`, версия раскрывается; см. W07 |

Сообщение `PASS: final exact-source release qualification` внутри Python unittest относится к синтетическому тестовому сценарию. Оно **не означает**, что реальный релиз прошёл qualification.

Большие suite других проектов, PTY и browser acceptance из прежнего implementation ledger в этом аудите заново полностью не выполнялись. Проходящие проверки подтверждают отдельные свойства runtime и integration boundary; они не опровергают статические нарушения workflow.

## Что уже соответствует выбранной архитектуре

- Adapter — самостоятельная конфигурация provider/model/profile, а не только название SDK. Consumer выбирает разрешённый Adapter; доменные prompts/jobs остаются у consumer.
- Provider key разрешается через Kernel/Volt; отдельные identities и exact grants ограничивают доступ, а ротация учитывает value revision, не только Register revision.
- Один локальный Wyvern переиспользуется через Updater; admin и client sockets разделены. Web consumer не получает Docker/host-admin доступ.
- Wyvern выполняет исходящий provider request с credential Adapter. Отдельный домен для локального UDS-профиля не требуется; remote HTTPS — явный вариант подключения.
- Fixed external-state lifecycle имеет собственную модель drain/journal/rollback/repair. По принятому Part 09 не требуется откатывать глобальное содержимое Kernel/Volt или добавлять application ZIP к каждому runtime update Wyvern.
- Собственный web-интерфейс Wyvern не обязателен: согласованный интерфейс управления — общий TUI и Settings потребителей. CSS-требования к web cards не переносятся буквально на терминал.

Эти выводы относятся к принятому проектному контракту и проверенной реализации. Они не являются общей сертификацией безопасности или доказательством production deployment.

## Оставшаяся квалификация и порядок закрытия

Не выполнялись: чистый реальный host install/update/rollback/repair с systemd и полное encrypted recovery; actual remote ingress/TLS и внешние exposure probes; Termius desktop/mobile; live-provider запросы; production signing/publication; проверка настроек защиты GitHub environment/tag/branch. Совместимые опубликованные dependency releases и актуальность consumer artifact pins также не сертифицированы этим аудитом.

Live-provider проверки не следует автоматически смешивать с release gate: Part 05 допускает fixture-квалификацию артефактов, оставляя реальные production inputs в deployment readiness. Их отсутствие надо честно обозначать, а не заменять фиктивным PASS.

Рекомендуемый порядок:

1. Закрыть W01–W03: публикация, signing isolation, ограничение эксплуатационных логов.
2. Закрыть W04–W07: воспроизводимые gates, candidate evidence, supply chain, audit и exposure.
3. Закрыть W08–W10 в Wyvern, Updater и двух потребителях: Settings, scoped backup intent, документация. Не расширять полномочия consumer ради UI.
4. Выполнить проверки на новом точном candidate, сохранить полный Part 12 отчёт и отдельно квалифицировать deployment-профиль.

Изменение центральных требований в обход этих пробелов не предлагается. Этот отчёт фиксирует рекомендуемые исправления, но не принимает новых архитектурных исключений.
