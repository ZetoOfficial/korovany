# Деплой

| | Основной сервер | Ручной fallback |
|---|---|---|
| Игра | https://korovany.zetoqqq.ru/ | https://zetoqqq.ru/korovany/ |
| SSH | `kz-vpn` (`95.57.50.133`) | `vdsina.2gb.com` (`62.84.101.20`) |
| Путь сборки | `/` | `/korovany/` |
| GitHub environment | `production-kz` | `production` |
| GitHub artifact | `korovany-kz-linux-amd64` | `korovany-linux-amd64` |

На `kz-vpn` nginx принимает HTTPS/WSS и передаёт запросы игре на `127.0.0.1:8090`. Сертификат продлевает `certbot.timer`. Старая площадка работает через nginx на `zetoqqq.ru` и обратный SSH-туннель к игровому VDS. Рабочие конфигурации находятся на серверах.

## CI/CD

Workflow `.github/workflows/ci.yml` тестирует оба пути. После успешного push в `master` деплой идёт только на `kz-vpn`. Pull request и другие ветки ничего не разворачивают. Ручной запуск на `master`: `target=production` (по умолчанию) или `target=fallback`.

Запуск старого деплоя: **Actions → Test and deploy → Run workflow → master → target: fallback**, либо:

```sh
gh workflow run ci.yml --ref master -f target=fallback
```

Fallback обновляет старую площадку; DNS не переключается. На каждый сервер отправляется соответствующий проверенный артефакт. Деплои одного сервера выполняются последовательно; устаревший коммит пропускается, если в `master` уже есть более новый.

В environment `production-kz` нужно добавить `DEPLOY_SSH_KEY` и `DEPLOY_KNOWN_HOSTS` для нового сервера и разрешить только ветку `master`. Существующие secrets в `production` остаются для старого сервера. Ключи CI ограничены командами деплоя и отката, без произвольного shell.

Приёмник `receive.sh` переключает `/srv/korovany/current`, перезапускает игру и проверяет SHA релиза. На `kz-vpn` файл `/etc/korovany/deploy.conf` задаёт `health_url=http://127.0.0.1:8090/api/health`; без этого файла используется старый путь `/korovany/api/health`. При неудачном запуске возвращается предыдущий релиз. Ошибка последующей проверки публичного HTTPS помечает CI неуспешным, но сама по себе не вызывает откат.

## Проверка и откат

```sh
curl -fsS https://korovany.zetoqqq.ru/api/health
ssh kz-vpn 'systemctl status korovany nginx certbot.timer --no-pager'
ssh kz-vpn 'journalctl -u korovany -n 100 --no-pager'
ssh kz-vpn 'ls -lt /srv/korovany/releases; readlink /srv/korovany/previous'
# Заменить <SHA> полным SHA установленного релиза:
ssh kz-vpn 'sudo -u korovany-deploy env SSH_ORIGINAL_COMMAND="rollback <SHA>" /usr/local/bin/korovany-deploy'
```

Для fallback проверять `https://zetoqqq.ru/korovany/api/health`, службы `korovany` и `korovany-tunnel` на `vdsina.2gb.com`, nginx на `zetoqqq.ru`. Команда отката та же, с SSH-хостом `vdsina.2gb.com`.

Хранятся пять последних релизов плюс текущий и предыдущий. Деплой и откат завершают текущие матчи. Комнаты серверов независимы; сохранения кампании в браузере не переносятся между доменами автоматически.
