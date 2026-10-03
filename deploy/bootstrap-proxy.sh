#!/usr/bin/env bash
# Run as root on zetoqqq.ru beside deploy/ and tunnel-key.pub.
set -euo pipefail
test "$(id -u)" = 0
id korovany-tunnel >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin korovany-tunnel
install -d -o korovany-tunnel -g korovany-tunnel -m 700 /home/korovany-tunnel/.ssh
{ printf '%s ' 'from="62.84.101.20",restrict,port-forwarding,permitlisten="127.0.0.1:18090",command="/bin/false"'; cat tunnel-key.pub; } > /home/korovany-tunnel/.ssh/authorized_keys
chown korovany-tunnel:korovany-tunnel /home/korovany-tunnel/.ssh/authorized_keys
chmod 600 /home/korovany-tunnel/.ssh/authorized_keys
cat > /etc/ssh/sshd_config.d/korovany.conf <<'EOF'
Match User korovany-tunnel
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:18090
    GatewayPorts no
    PasswordAuthentication no
    PermitTTY no
Match all
EOF
sshd -t
systemctl reload ssh
install -m 644 deploy/nginx.conf /etc/nginx/snippets/korovany.conf
config=/etc/nginx/sites-available/zetoqqq.ru
backup="${config}.before-korovany-$(date +%Y%m%d%H%M%S)"
cp -a "$config" "$backup"
python3 - "$config" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
line = "    include /etc/nginx/snippets/korovany.conf;"
if line not in text:
    anchor = "    server_name zetoqqq.ru;"
    assert text.count(anchor) == 1, "HTTPS server block needs manual inspection"
    path.write_text(text.replace(anchor, anchor + "\n" + line, 1))
PY
if ! nginx -t; then
  cp -a "$backup" "$config"
  exit 1
fi
systemctl reload nginx
