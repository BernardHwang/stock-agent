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

# Generate OpenD.xml inside the container at startup so credentials never live in git
cat > /opt/opend/OpenD.xml <<EOF
<?xml version="1.0" encoding="utf-8"?>
<root>
    <login_account>${MOOMOO_LOGIN_ACCOUNT}</login_account>
EOF

if [ -n "${MOOMOO_LOGIN_PWD_MD5:-}" ]; then
  cat >> /opt/opend/OpenD.xml <<EOF
    <login_pwd_md5>${MOOMOO_LOGIN_PWD_MD5}</login_pwd_md5>
EOF
else
  cat >> /opt/opend/OpenD.xml <<EOF
    <login_pwd>${MOOMOO_LOGIN_PWD}</login_pwd>
EOF
fi

cat >> /opt/opend/OpenD.xml <<EOF
    <lang>en</lang>
    <api_ip>0.0.0.0</api_ip>
    <api_port>11111</api_port>
    <telnet_ip>127.0.0.1</telnet_ip>
    <telnet_port>22222</telnet_port>
    <log_level>info</log_level>
    <auto_hold_quote_right>1</auto_hold_quote_right>
</root>
EOF

chmod 600 /opt/opend/OpenD.xml

# Find the OpenD binary (located either at /opt/opend/OpenD or in a subfolder depending on archive layout)
OPEND_BIN="/opt/opend/OpenD"
if [ ! -x "$OPEND_BIN" ]; then
  FOUND=$(find /opt/opend -maxdepth 3 -type f -name "OpenD" | head -n 1)
  if [ -n "$FOUND" ]; then
    OPEND_BIN="$FOUND"
    chmod +x "$OPEND_BIN"
  fi
fi

cd "$(dirname "$OPEND_BIN")"
exec "$OPEND_BIN"
