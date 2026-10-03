#!/usr/bin/env bash
# Installed root-owned; invoked by a restricted SSH key as korovany-deploy.
set -euo pipefail
umask 022
read -r action revision extra <<< "${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$action" =~ ^(deploy|rollback)$ || ! "$revision" =~ ^[a-f0-9]{40}$ || -n "${extra:-}" ]]; then
  echo 'Expected: deploy <commit SHA> or rollback <commit SHA>' >&2
  exit 2
fi
cd /srv/korovany
exec 9>.deploy.lock
flock -w 300 9
stage=''
trap 'if [[ -n "$stage" ]]; then rm -rf -- "$stage"; fi' EXIT
if [[ "$action" == deploy ]]; then
  stage=$(mktemp -d /srv/korovany/.incoming.XXXXXX)
  chmod 755 "$stage"
  /usr/local/lib/korovany-unpack.py "$stage"
  if [[ -d "releases/$revision" ]]; then
    echo "Reusing existing immutable release $revision"
    rm -rf -- "$stage"
  else
    mv "$stage" "releases/$revision"
  fi
  stage=''
fi
test -x "releases/$revision/bin/korovany"
previous=$(readlink current || true)
activate() {
  ln -sfn "$1" .current-next
  mv -Tf .current-next current
  # A crashing release can exhaust systemd's start limit before rollback.
  sudo -n /usr/bin/systemctl reset-failed korovany.service
  sudo -n /usr/bin/systemctl restart korovany.service
}
healthy() {
  for attempt in $(seq 1 30); do
    if curl --max-time 2 -fsS http://127.0.0.1:8090/korovany/api/health 2>/dev/null |
      python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(v.get("status") != "ok" or v.get("revision") != sys.argv[1])' "$revision" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
if activate "releases/$revision" && healthy; then
  if [[ -n "$previous" && "$previous" != "releases/$revision" ]]; then
    ln -sfn "$previous" .previous-next
    mv -Tf .previous-next previous
  fi
  echo "Healthy release: $revision"
else
  echo 'Release failed health check; restoring previous release.' >&2
  if [[ -n "$previous" ]]; then
    activate "$previous"
  fi
  exit 1
fi
# Retain five newest releases, plus current and previous, for manual rollback.
current_target=$(readlink current)
previous_target=$(readlink previous || true)
while read -r old; do
  if [[ "$old" != "$current_target" && "$old" != "$previous_target" ]]; then
    rm -rf -- "$old"
  fi
done < <(find releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
