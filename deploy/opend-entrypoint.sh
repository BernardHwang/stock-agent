#!/usr/bin/env sh
set -eu

if [ -z "${MOOMOO_LOGIN_ACCOUNT:-}" ]; then
  echo "ERROR: MOOMOO_LOGIN_ACCOUNT is not set in .env" >&2
  exit 1
fi

if [ -z "${MOOMOO_LOGIN_PWD_MD5:-}" ] && [ -z "${MOOMOO_LOGIN_PWD:-}" ]; then
  echo "ERROR: Set MOOMOO_LOGIN_PWD_MD5 (recommended, 32-char lowercase MD5 of your password) or MOOMOO_LOGIN_PWD in .env" >&2
  exit 1
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Generate OpenD.xml inside the container at startup so credentials never live in git.
# Schema must match the FutuOpenD.xml shipped in the tarball (root <futu_opend>, listen address <ip>),
# otherwise OpenD prints "加载本地配置失败" (failed to load local config) and exits.
{
  echo '<futu_opend>'
  echo "    <ip>0.0.0.0</ip>"
  echo "    <api_port>11111</api_port>"
  echo "    <login_account>$(xml_escape "$MOOMOO_LOGIN_ACCOUNT")</login_account>"
  if [ -n "${MOOMOO_LOGIN_PWD_MD5:-}" ]; then
    echo "    <login_pwd_md5>$(xml_escape "$MOOMOO_LOGIN_PWD_MD5")</login_pwd_md5>"
  else
    echo "    <login_pwd>$(xml_escape "$MOOMOO_LOGIN_PWD")</login_pwd>"
  fi
  echo "    <lang>en</lang>"
  echo "    <log_level>info</log_level>"
  echo "    <push_proto_type>0</push_proto_type>"
  echo "    <telnet_ip>127.0.0.1</telnet_ip>"
  echo "    <telnet_port>22222</telnet_port>"
  echo "    <auto_hold_quote_right>1</auto_hold_quote_right>"
  echo '</futu_opend>'
} > /opt/opend/OpenD.xml

chmod 600 /opt/opend/OpenD.xml

# Find the OpenD binary (named either FutuOpenD or OpenD inside /opt/opend or Futu_OpenD-Ubuntu18.04-x64)
OPEND_BIN="$(find /opt/opend -maxdepth 4 -type f \( -name 'FutuOpenD' -o -name 'OpenD' \) | head -n 1)"
if [ -z "$OPEND_BIN" ]; then
  echo "ERROR: Could not find FutuOpenD or OpenD binary under /opt/opend" >&2
  exit 1
fi
chmod +x "$OPEND_BIN"

OPEND_DIR="$(dirname "$OPEND_BIN")"
cp -f /opt/opend/OpenD.xml "$OPEND_DIR/FutuOpenD.xml"
if [ "$OPEND_DIR" != "/opt/opend" ]; then
  cp -f /opt/opend/OpenD.xml "$OPEND_DIR/OpenD.xml"
fi
chmod 600 "$OPEND_DIR"/*.xml

# Ensure FutuOpenD's local cache/appdata folder exists and is writable
mkdir -p /home/opend/.com.futunn.FutuOpenD /home/opend/.com.moomoo.OpenD

cd "$OPEND_DIR"
exec "$OPEND_BIN" -cfg_file="$OPEND_DIR/FutuOpenD.xml"
