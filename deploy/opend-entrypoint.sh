#!/usr/bin/env sh
set -eu

# moomoo OpenD 10.x ignores login_account/login_pwd_md5 (in the XML and on the command line) and asks
# "Please enter account" on the console. Log in once with `docker compose attach opend` and answer Y to
# "remember"; the login is kept in ~/.com.moomoo.OpenD, which compose persists as data/opend.
# Schema must match the OpenD.xml shipped in the moomoo tarball (root <moomoo_opend>, listen address <ip>),
# otherwise OpenD prints "加载本地配置失败" (failed to load local config) and exits.
cat > /opt/opend/OpenD.xml <<'EOF2'
<moomoo_opend>
    <ip>0.0.0.0</ip>
    <api_port>11111</api_port>
    <lang>en</lang>
    <log_level>info</log_level>
    <push_proto_type>0</push_proto_type>
    <telnet_ip>127.0.0.1</telnet_ip>
    <telnet_port>22222</telnet_port>
    <auto_hold_quote_right>1</auto_hold_quote_right>
</moomoo_opend>
EOF2

chmod 600 /opt/opend/OpenD.xml

OPEND_BIN="$(find /opt/opend -maxdepth 4 -type f -name 'OpenD' | head -n 1)"
if [ -z "$OPEND_BIN" ]; then
  echo "ERROR: Could not find the OpenD binary under /opt/opend" >&2
  exit 1
fi
chmod +x "$OPEND_BIN"

OPEND_DIR="$(dirname "$OPEND_BIN")"
if [ "$OPEND_DIR" != "/opt/opend" ]; then
  cp -f /opt/opend/OpenD.xml "$OPEND_DIR/OpenD.xml"
fi
chmod 600 "$OPEND_DIR/OpenD.xml"

mkdir -p /home/opend/.com.moomoo.OpenD

cd "$OPEND_DIR"
exec "$OPEND_BIN" -cfg_file="$OPEND_DIR/OpenD.xml"
