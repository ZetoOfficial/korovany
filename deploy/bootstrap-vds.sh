#!/usr/bin/env bash
# Run as root on vdsina.2gb.com beside deploy/, deploy-key.pub, tunnel-key and known_hosts.
set -euo pipefail
test "$(id -u)" = 0
for executable in python3 curl flock sudo sshd; do command -v "$executable" >/dev/null; done
id korovany >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin korovany
id korovany-deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash korovany-deploy
id korovany-proxy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin korovany-proxy
install -d -o korovany-deploy -g korovany-deploy -m 755 /srv/korovany /srv/korovany/releases
install -m 644 deploy/korovany.service /etc/systemd/system/korovany.service
install -m 755 deploy/receive.sh /usr/local/bin/korovany-deploy
install -d /usr/local/lib
install -m 755 deploy/unpack.py /usr/local/lib/korovany-unpack.py
printf '%s\n' 'korovany-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart korovany.service, /usr/bin/systemctl reset-failed korovany.service' > /etc/sudoers.d/korovany
chmod 440 /etc/sudoers.d/korovany
visudo -cf /etc/sudoers.d/korovany
install -d -m 700 -o korovany-deploy -g korovany-deploy /home/korovany-deploy/.ssh
{ printf '%s ' 'restrict,command="/usr/local/bin/korovany-deploy"'; cat deploy-key.pub; } > /home/korovany-deploy/.ssh/authorized_keys
chown korovany-deploy:korovany-deploy /home/korovany-deploy/.ssh/authorized_keys
chmod 600 /home/korovany-deploy/.ssh/authorized_keys
install -d -o korovany-proxy -g korovany-proxy -m 700 /etc/korovany-tunnel
install -o korovany-proxy -g korovany-proxy -m 600 tunnel-key /etc/korovany-tunnel/id_ed25519
install -o korovany-proxy -g korovany-proxy -m 600 known_hosts /etc/korovany-tunnel/known_hosts
install -m 644 deploy/korovany-tunnel.service /etc/systemd/system/korovany-tunnel.service
cat > /etc/ssh/sshd_config.d/korovany.conf <<'EOF'
Match User korovany-deploy
    DisableForwarding yes
    PasswordAuthentication no
    PermitTTY no
Match all
EOF
sshd -t
systemctl reload ssh
systemctl daemon-reload
systemctl enable korovany.service
systemctl enable --now korovany-tunnel.service
