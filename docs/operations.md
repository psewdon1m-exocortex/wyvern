# Установка и эксплуатация Wyvern 0.0.1

Wyvern работает как один общий компонент хоста. Внешний запрос отправляет Wyvern с API key выбранного Adapter. Внутренний сервис аутентифицируется своим отдельным токеном. Локальной установке домен не нужен: используется `/run/wyvern/client.sock`.

## Первый запуск

Подписанные пакеты Mastermind и Laboratory включают подписанный `wyvern-release.json`, его подпись и совместимый пакет Updater. Установка проверяет подписи, устанавливает либо сохраняет более новый Updater, затем устанавливает Wyvern или использует существующий управляемый экземпляр. Версия установленного gateway не меняется неявно при установке потребителя. Повреждённая управляемая установка требует `sudo updater wyvern repair`.

Для самостоятельной установки выпускается `bootstrap.sh` со встроенным публичным ключом релиза. Он проверяет подпись манифеста RSA-PSS-SHA256 и SHA-256 установочного архива до запуска вложенного установщика. Сам bootstrap получают по доверенному каналу. Нужны Linux amd64, Docker, systemd, Python 3, OpenSSL и сеть к Kernel/Google. Updater поставляется в том же подписанном архиве.

1. Открыть `sudo updater tui`, выбрать Wyvern → Connect Kernel. Ввести HTTPS origin Kernel и его Access Key. Ключ ввода скрыт и не сохраняется. Kernel должен быть соединён с разблокированным Volt.
2. Создать Google Adapter: устойчивый ID, название, поддерживаемый Google model ID, API key, профиль, capabilities и лимит ответа. Для полного Mastermind нужны text, structured_output, token_count, image, pdf, audio, video, youtube; Laboratory нужны text, structured_output, pdf. Streaming включается отдельно.
3. В Settings потребителя нажать Connect through Updater. Если клиент создан до Adapter, в TUI назначить ему разрешённые Adapter IDs. Пустой список запрещает все Adapter; новые Adapter не расширяют старые grants автоматически.
4. В отдельной карточке Wyvern выбрать привязки: Mastermind `text` и `media`; Laboratory `derivatives`.

Installed, configuration loaded, client linked, Adapter selected и llm_ready — разные состояния. `llm_ready` подтверждает конфигурацию, разрешения и отсутствие drain; проверка статуса не делает платный запрос и не удостоверяет внешний баланс или квоту. Отсутствие Wyvern не останавливает функции потребителя, не использующие LLM.

## Границы данных и доступа

API keys и конфигурация Adapter хранятся в Volt. Kernel ведёт только ссылки и SHA-256 verifier машинных идентичностей. Runtime получает точные разрешения на конфигурацию своего instance и его credentials; менеджер имеет только типизированные операции над своим instance. Legacy machine token не разрешает Wyvern keys и алиасы на их значения.

На хосте сохраняются bootstrap identity `/etc/wyvern/identity`, root-only менеджер `/etc/exocortex/wyvern/manager.json` и отдельный клиентский каталог `/etc/exocortex/wyvern/clients/<head>/link.json`. Потребитель монтирует только собственный каталог и data socket, оба read-only. Каталог целиком позволяет видеть атомарную ротацию файла. Laboratory использует дополнительную группу 10001. Admin socket `/run/wyvern-admin/admin.sock` не монтируется в потребителей.

API key можно заменить через Create / edit Google Adapter; пустое поле сохраняет текущий ключ. Локальные клиентские токены восстанавливаются/ротируются явно: `sudo updater wyvern rotate-client --client <id>`. Ротация сохраняет grants, bindings и состояние revoked, поддерживает повтор после потери ответа. Runtime подхватывает изменение при reload либо очередном обновлении snapshot; максимальное окно принятия устаревших разрешений определяется `max_auth_stale_ms` (по умолчанию 5 минут). Уже принятая операция использует зафиксированный snapshot до завершения.

## Удалённый gateway

Удалённое подключение выбирается явно, без автоматического отката на локальный gateway. Можно использовать существующий HTTPS domain с префиксом `/wyvern`; отдельное доменное имя необязательно. На сервере выдаётся клиентский файл:

```sh
sudo updater wyvern export-link --client mastermind --service mastermind --url https://host.example/wyvern --output /root/mastermind-wyvern.json
```

На хосте потребителя после регистрации head:

```sh
sudo updater wyvern import-link --head mastermind < /root/mastermind-wyvern.json
```

Файл передают защищённым каналом и удаляют после импорта. CLI не печатает токен. Импорт проверяет TLS, schema, instance и client ID через `/v1/client`, затем атомарно заменяет link. Для нескольких потребителей одной службы нужны разные зарегистрированные head/client IDs; ID файла должен совпадать с локальным head. Повторный export после ротации использует новый токен.

Пример Nginx в уже существующем TLS server block (upstream объявляется в http context):

```nginx
upstream wyvern_data { server unix:/run/wyvern/client.sock; }
location ^~ /wyvern/ {
    rewrite ^/wyvern/(.*)$ /$1 break;
    proxy_pass http://wyvern_data;
    proxy_http_version 1.1;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Connection "";
    proxy_request_buffering off;
    proxy_buffering off;
    client_max_body_size 512m;
    proxy_read_timeout 310s;
    proxy_send_timeout 310s;
    add_header X-Robots-Tag "noindex, nofollow" always;
}
```

Worker Nginx получает группу сокета (GID 10001); admin socket не проксируется. Authorization не должен попадать в access log. TLS и правила существующего host ingress сохраняются. Gateway проверяет токен на каждом клиентском запросе независимо от ingress.

## Обновление, сбой и восстановление

Обновление Wyvern доступно root через общую TUI. Потребитель может запросить install/reuse и связать только себя, но не обновить/остановить весь gateway. Updater использует host lock и подписанный типизированный манифест `exocortex.wyvern.release.v1`, требует image digest и совместимые API/config/capabilities. До остановки runtime обновляет snapshot и ждёт завершения активных запросов. При превышении drain timeout старая версия сохраняется. Неудачная активация возвращает предыдущий image и unit; сбой rollback отражается отдельно.

Журнал `/var/lib/updater/components/wyvern/transaction.json` обеспечивает `sudo updater wyvern repair` после прерывания. Нельзя удалять журнал для обхода незавершённой операции. Ни обновление, ни rollback runtime не восстанавливают глобальный Register или Volt: текущая внешняя конфигурация остаётся authoritative. Исключение из обычного application backup реализовано только для этого фиксированного профиля; пользовательского `backup_required=false` нет.

Зашифрованное host recovery включает runtime/manager/client identities и `/var/lib/wyvern`, но не исполняемые файлы, systemd unit, image environment или deployment manifest. На чистом хосте сначала ставят доверенный подписанный пакет, затем восстанавливают соответствующие Kernel, Volt и host archive. Старый архив без Wyvern сохраняет существующие Wyvern roots. Не совпавшая внешняя идентичность приводит к ошибке health verification и откату восстановления.

Медиа ограничены 50 MiB для PDF, 512 MiB для остальных типов; 16 handles на клиента, 256 на runtime, 4 одновременные загрузки. Локальный TTL — час. Ledger сохраняет opaque ID, принадлежность, provider file name и hash поколения credential, но не API key, upload URL или содержимое. Истёкший/чужой/несовместимый handle возвращает 410. Mastermind выполняет до двух повторных загрузок в пределах бюджета задания, Laboratory — собственную политику повтора jobs. Gateway не повторяет inference. Cleanup выполняется после обработки и ограниченными порциями при истечении TTL; окончательное удаление недоступного provider file зависит от политики провайдера.

## Миграция существующих потребителей

Настроить Adapter и bindings до включения LLM jobs. Старые `ai_provider_key`, `mastermind.crusher.*_model`, `services.laboratory.ai.gemini_api_key` и `LABORATORY_GEMINI_*` больше не используются. После проверки остальных потребителей удалить устаревшие Register bindings и отозвать старый ключ у провайдера; перенос ссылок сам по себе не отзывает ранее выданный секрет. Промпты, очередь, ограничения бюджета, проверка доказательств, embeddings и запись результата остаются в сервисах. Старые медиа checkpoints Mastermind переводятся в ограниченный re-upload через Wyvern.
