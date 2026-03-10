#!/bin/sh
set -eu

if [ ! -f "${SSL_CERT_PATH}" ]; then
  echo "Missing TLS certificate: ${SSL_CERT_PATH}" >&2
  exit 1
fi

if [ ! -f "${SSL_KEY_PATH}" ]; then
  echo "Missing TLS private key: ${SSL_KEY_PATH}" >&2
  exit 1
fi

SSL_TRUSTED_CERT_DIRECTIVE=""
if [ -n "${SSL_TRUSTED_CERT_FILE:-}" ]; then
  SSL_TRUSTED_CERT_PATH="/etc/nginx/certs/${SSL_TRUSTED_CERT_FILE}"
  if [ ! -f "${SSL_TRUSTED_CERT_PATH}" ]; then
    echo "Missing trusted CA certificate bundle: ${SSL_TRUSTED_CERT_PATH}" >&2
    exit 1
  fi
  SSL_TRUSTED_CERT_DIRECTIVE="ssl_trusted_certificate ${SSL_TRUSTED_CERT_PATH};"
fi

export WEB_UPSTREAM SERVER_NAME SSL_CERT_PATH SSL_KEY_PATH SSL_TRUSTED_CERT_DIRECTIVE
envsubst '${WEB_UPSTREAM} ${SERVER_NAME} ${SSL_CERT_PATH} ${SSL_KEY_PATH} ${SSL_TRUSTED_CERT_DIRECTIVE}' \
  < /opt/nginx/default.conf.template \
  > /etc/nginx/conf.d/default.conf
