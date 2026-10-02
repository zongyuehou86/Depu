#!/bin/zsh
set -e
set -o pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}"

if [[ ! -d node_modules/ws ]]; then
  npm install --omit=dev
fi

port="${PORT:-3000}"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if curl --noproxy '*' --silent --fail --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null; then
  echo "本机牌桌已在运行，正在生成新的分享网址。"
else
  HOST=127.0.0.1 PORT="$port" node server.js &
  server_pid=$!
  ready=false
  for attempt in {1..30}; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "牌桌服务器未能启动，请查看上面的错误。"
      exit 1
    fi
    if curl --noproxy '*' --silent --fail --max-time 2 "http://127.0.0.1:$port/api/health" >/dev/null; then
      ready=true
      break
    fi
    sleep 0.2
  done
  if [[ "$ready" != true ]]; then
    echo "牌桌服务器启动超时。"
    exit 1
  fi
fi

echo "本机牌桌：http://127.0.0.1:$port"
echo "正在生成可分享的网址；保持这个窗口和电脑运行。按 Ctrl+C 可停止服务。"
caffeinate -i cloudflared tunnel --url "http://127.0.0.1:$port" 2>&1 | awk '
  { print; fflush() }
  !shown && match($0, /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/) {
    print "\n可分享网址：" substr($0, RSTART, RLENGTH) "\n";
    fflush();
    shown = 1
  }
'
