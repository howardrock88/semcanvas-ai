#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${SEMCANVAS_SERVICE_LABEL:-ai.semcanvas.local}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT_LOG="$HOME/Library/Logs/semcanvas-ai.out.log"
ERR_LOG="$HOME/Library/Logs/semcanvas-ai.err.log"
ACTION="${1:-status}"
UID_VALUE="$(id -u)"
DOMAIN="gui/$UID_VALUE"
TARGET="$DOMAIN/$LABEL"

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "macOS launchd service scripts only work on macOS." >&2
    exit 1
  fi
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

find_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    printf '%s' "$NODE_BIN"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  echo "node was not found. Install Node.js 18+ first." >&2
  exit 1
}

build_path() {
  local node_bin="$1"
  local node_dir codex_dir result
  node_dir="$(dirname "$node_bin")"
  codex_dir=""
  result=""
  if command -v codex >/dev/null 2>&1; then
    codex_dir="$(dirname "$(command -v codex)")"
  fi
  for dir in "$node_dir" "$codex_dir" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    [[ -z "$dir" ]] && continue
    [[ ":$result:" == *":$dir:"* ]] && continue
    result="${result:+$result:}$dir"
  done
  printf '%s' "$result"
}

ensure_env_file() {
  if [[ ! -f "$ROOT/.env" && -f "$ROOT/.env.example" ]]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    echo "Created .env from .env.example"
  fi
}

read_env_value() {
  local key="$1"
  local fallback="$2"
  local file="$ROOT/.env"
  if [[ -f "$file" ]]; then
    local line
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$key=" "$file" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      line="${line#*=}"
      line="${line%\"}"
      line="${line#\"}"
      line="${line%\'}"
      line="${line#\'}"
      printf '%s' "$line"
      return
    fi
  fi
  printf '%s' "$fallback"
}

write_plist() {
  local node_bin="$1"
  local service_path="$2"
  local root_xml node_xml home_xml path_xml out_xml err_xml label_xml
  root_xml="$(xml_escape "$ROOT")"
  node_xml="$(xml_escape "$node_bin")"
  home_xml="$(xml_escape "$HOME")"
  path_xml="$(xml_escape "$service_path")"
  out_xml="$(xml_escape "$OUT_LOG")"
  err_xml="$(xml_escape "$ERR_LOG")"
  label_xml="$(xml_escape "$LABEL")"

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_xml</string>
    <string>$root_xml/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root_xml</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$home_xml</string>
    <key>PATH</key>
    <string>$path_xml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$out_xml</string>
  <key>StandardErrorPath</key>
  <string>$err_xml</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null
}

is_loaded() {
  launchctl print "$TARGET" >/dev/null 2>&1
}

stop_loaded_service() {
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
}

start_service() {
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl enable "$TARGET"
  launchctl kickstart -k "$TARGET"
}

print_status() {
  local host port
  host="$(read_env_value HOST 127.0.0.1)"
  port="$(read_env_value PORT 4321)"
  if is_loaded; then
    launchctl print "$TARGET" | sed -n '1,90p'
  else
    echo "$LABEL is not loaded."
  fi
  echo
  echo "URL: http://$host:$port"
  echo "stdout: $OUT_LOG"
  echo "stderr: $ERR_LOG"
}

install_service() {
  ensure_env_file
  local node_bin service_path
  node_bin="$(find_node)"
  service_path="$(build_path "$node_bin")"
  write_plist "$node_bin" "$service_path"
  stop_loaded_service
  start_service

  if ! command -v codex >/dev/null 2>&1; then
    echo "Warning: codex CLI was not found in PATH. The default codex provider will fail until the user installs and logs in to Codex." >&2
  fi

  local host port
  host="$(read_env_value HOST 127.0.0.1)"
  port="$(read_env_value PORT 4321)"
  echo "Installed and started $LABEL"
  echo "Open http://$host:$port"
}

require_macos
case "$ACTION" in
  install)
    install_service
    ;;
  start)
    if [[ ! -f "$PLIST" ]]; then
      install_service
    else
      stop_loaded_service
      start_service
      print_status
    fi
    ;;
  stop)
    stop_loaded_service
    echo "Stopped $LABEL"
    ;;
  restart)
    if is_loaded; then
      launchctl kickstart -k "$TARGET"
    else
      install_service
    fi
    print_status
    ;;
  status)
    print_status
    ;;
  uninstall)
    stop_loaded_service
    rm -f "$PLIST"
    echo "Uninstalled $LABEL"
    ;;
  logs)
    touch "$OUT_LOG" "$ERR_LOG"
    tail -f "$OUT_LOG" "$ERR_LOG"
    ;;
  *)
    cat <<USAGE
Usage: tools/service_macos.sh <install|start|stop|restart|status|uninstall|logs>

Environment overrides:
  SEMCANVAS_SERVICE_LABEL  launchd label, default: ai.semcanvas.local
  NODE_BIN                 node binary path, default: first node in PATH
USAGE
    exit 2
    ;;
esac
