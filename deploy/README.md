# Production

Кампания: https://zetoqqq.ru/korovany/ · PvP: https://zetoqqq.ru/korovany/arena/

## Схема

Браузер → HTTPS/WSS nginx на `zetoqqq.ru` (`89.110.93.237`) → локальный порт `18090` → SSH-туннель → Go на `vdsina.2gb.com` (`62.84.101.20`), `127.0.0.1:8090`.

Туннель инициирует игровой VDS. Входящее соединение в обратном направлении между этими серверами при настройке не проходило. Отдельные игровые порты в интернет не открыты. DNS, сертификат домена, главная страница сайта и существующие приложения не меняются. Дополнительный сервер на пути добавляет задержку; для минимального пинга можно позже выделить домен прямо игровому VDS.

## Автодеплой

`.github/workflows/ci.yml` запускается для push и pull request. Проверяет TypeScript, клиентскую симуляцию, Go с race detector, go vet, распаковку релизов, затем кампанию и PvP в двух браузерах. Матрица проверяет `/` и `/korovany/`.

Только успешный push в `master` или ручной запуск workflow на `master` допускается к окружению `production`. На VDS отправляется тот же Linux amd64 бинарник и клиент, которые прошли браузерные тесты. Сборки на VDS нет. Production разворачивается последовательно, без прерывания текущего деплоя.

Environment secrets: `DEPLOY_SSH_KEY` (отдельный ключ пользователя `korovany-deploy`) и `DEPLOY_KNOWN_HOSTS` (проверенный публичный ключ SSH сервера). Приватных ключей в репозитории нет. Ключ CI ограничен командами `deploy <40-символьный SHA>` и `rollback <SHA>`; произвольный shell и forwarding запрещены. Единственное разрешение sudo — перезапуск `korovany.service`. Ветка окружения ограничена `master`.

Каждый релиз лежит в `/srv/korovany/releases/<SHA>`. Скрипт атомарно переключает `current`, перезапускает Go и сверяет SHA в `/korovany/api/health`. Если новый сервер не запускается, возвращает предыдущий релиз. Затем CI проверяет публичный HTTPS-маршрут. Ошибка только внешнего маршрута помечает workflow неуспешным и требует проверки nginx/туннеля; автоматический откат применяется к проверке самого игрового сервера.

Хранятся пять последних релизов, а также цели `current` и `previous`. Artifact в GitHub хранится 14 дней. Системные службы запускаются после перезагрузки; Go перезапускается после сбоя, SSH — после обрыва соединения. Игра работает без root, с лимитом памяти 512 MiB и файловой системой только для чтения. Комнаты хранятся в памяти: деплой, откат и рестарт завершают текущие матчи. База данных и резервное копирование матчей не требуются, поскольку постоянного серверного состояния пока нет.

## Состояние и логи

```sh
curl -fsS https://zetoqqq.ru/korovany/api/health
ssh vdsina.2gb.com 'systemctl status korovany korovany-tunnel --no-pager'
ssh vdsina.2gb.com 'journalctl -u korovany -u korovany-tunnel -n 100 --no-pager'
ssh zetoqqq.ru 'nginx -t; ss -lnt sport = :18090'
```

Если игра недоступна: сначала проверить Go локально на VDS, затем туннель, затем nginx. После ремонта туннеля `systemctl restart korovany-tunnel` выполняется на VDS. Ошибки прокси — `/var/log/nginx/error.log` на сервере домена. Обычные журналы обслуживает journald; отдельного внешнего мониторинга/уведомлений этот workflow не создаёт.

## Откат

Посмотреть доступные версии:

```sh
ssh vdsina.2gb.com 'ls -lt /srv/korovany/releases; readlink /srv/korovany/current; readlink /srv/korovany/previous'
```

Подставить полный SHA нужного релиза вместо `<SHA>`:

```sh
ssh vdsina.2gb.com 'sudo -u korovany-deploy env SSH_ORIGINAL_COMMAND="rollback <SHA>" /usr/local/bin/korovany-deploy'
```

## Воспроизведение конфигурации

`bootstrap-vds.sh` устанавливает пользователей, root-owned скрипт приёма релизов, systemd units и SSH-ограничения. Запускается root на VDS из каталога, содержащего `deploy/`, `deploy-key.pub`, приватный `tunnel-key` и `known_hosts` с проверенным ключом **сервера домена**. После установки удалите временную копию приватного ключа. Ключ туннеля хранится только в `/etc/korovany-tunnel/id_ed25519`, принадлежит `korovany-proxy` и имеет режим 600.

`bootstrap-proxy.sh` запускается root на сервере домена рядом с `deploy/` и `tunnel-key.pub`. Создаёт получателя обратного туннеля с единственным разрешённым портом `127.0.0.1:18090`, добавляет include в существующий HTTPS-блок nginx после резервной копии. Перед reload проверяет конфигурацию. Инфраструктурные файлы root-owned и не обновляются обычным CI: изменения в них применяются отдельно по SSH после ревью.

Для локальной проверки пути production:

```sh
npm run build -- --base=/korovany/
go build -o bin/korovany ./cmd/korovany
./bin/korovany -base-path /korovany/
# В другом терминале:
ASTRA_URL=http://127.0.0.1:8080/korovany/ npm run test:multiplayer
```

Параметр Vite `--base` и серверный `-base-path` должны совпадать. Обычный `make build` по-прежнему собирает игру для `/`.
