#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
node_home_candidate="$(printf '%s\n' "$HOME"/.local/share/bioeconomy/node-v*/bin 2>/dev/null | sort -Vr | head -n1)"
if [[ -x "$node_home_candidate/node" ]]; then export PATH="$node_home_candidate:$PATH"; fi
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
API_PORT=49173
WEB_PORT=5173
API_URL="http://127.0.0.1:$API_PORT"
WEB_URL="http://127.0.0.1:$WEB_PORT"
APP_PID=''
APP_GROUP_PID=''
APP_PIDFILE=''

log() { printf '\n\033[1;36m[Bioeconomy]\033[0m %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
  local status=$?
  trap - INT TERM EXIT
  # Signal the unique session created for this launcher, never a process name
  # or a shared shell/process group.
  if [[ -n "$APP_GROUP_PID" ]] && kill -0 -- "-$APP_GROUP_PID" 2>/dev/null; then
    kill -TERM -- "-$APP_GROUP_PID" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 -- "-$APP_GROUP_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$APP_GROUP_PID" 2>/dev/null || true
  fi
  [[ -n "$APP_PID" ]] && wait "$APP_PID" 2>/dev/null || true
  [[ -n "$APP_PIDFILE" ]] && rm -f -- "$APP_PIDFILE" || true
  exit "$status"
}
trap cleanup INT TERM HUP EXIT

for required in uv node npm curl ss; do command -v "$required" >/dev/null 2>&1 || fail "$required is missing. Run ./scripts/setup.sh or install the documented prerequisite."; done
[[ -d "$FRONTEND/node_modules" ]] || fail 'Frontend dependencies are missing. Run ./scripts/setup.sh.'
[[ -d "$BACKEND/.venv" ]] || fail 'Backend environment is missing. Run ./scripts/setup.sh.'
[[ -f "$BACKEND/.env" ]] || fail 'backend/.env is missing. Run ./scripts/setup.sh, then configure DATABASE_URL.'

api_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$API_URL/api/v1/health" 2>/dev/null || true)"
web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$WEB_URL/" 2>/dev/null || true)"
if [[ "$api_code" == 200 && "$web_code" == 200 ]]; then
  log "Bioeconomy is already responding. Frontend: $WEB_URL  API: $API_URL"
  exit 0
fi

for port in "$API_PORT" "$WEB_PORT"; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" | awk 'NR>1 {found=1} END {exit !found}'; then
    owner="$(ss -ltnp "sport = :$port" 2>/dev/null | tail -n +2 | sed -E 's/.*users:\(\("([^"]+)".*pid=([0-9]+).*/\1 (PID \2)/' | head -n1)"
    if [[ -z "$owner" ]] && command -v lsof >/dev/null 2>&1; then
      owner_pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | paste -sd, - || true)"
      [[ -z "$owner_pids" ]] || owner="$(ps -o comm= -p "$owner_pids" 2>/dev/null | paste -sd, -) (PID $owner_pids)"
    fi
    owner="${owner:-unknown; inspect with ss -ltnp}"
    fail "Port $port is occupied by PID ${owner:-unknown}; stop that service yourself or choose a free port."
  fi
done

log 'Checking PostgreSQL configuration and applying pending migrations.'
(cd "$BACKEND" && uv run --locked --no-sync python "$SCRIPT_DIR/dev_env.py" check-db) || fail 'Database connection failed; see backend/.env and PostgreSQL service/authentication.'
(cd "$BACKEND" && uv run --locked --no-sync alembic upgrade head) || fail 'Alembic migration failed; no database was reset.'

log "Starting API ($API_URL) and frontend ($WEB_URL). Press Ctrl+C to stop both."
# The shared npm script starts both API and Vite with concurrently. Run it in
# one dedicated process group so signal cleanup also reaches its children.
APP_PIDFILE="$(mktemp "${TMPDIR:-/tmp}/bioeconomy-start.XXXXXX")"
setsid bash -c 'printf "%s\n" "$$" > "$1"; cd "$2" && exec npm run dev' _ "$APP_PIDFILE" "$FRONTEND" &
APP_PID=$!
for _ in {1..50}; do
  if [[ -s "$APP_PIDFILE" ]]; then APP_GROUP_PID="$(cat -- "$APP_PIDFILE")"; break; fi
  kill -0 "$APP_PID" 2>/dev/null || true
  sleep 0.1
done
[[ "$APP_GROUP_PID" =~ ^[0-9]+$ ]] || fail 'Could not establish a dedicated process group for the application.'

log "Waiting for $WEB_URL and $API_URL/api/v1/health"
ready=false
for _ in {1..40}; do
  kill -0 -- "-$APP_GROUP_PID" 2>/dev/null || fail 'A service exited during startup.'
  api_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$API_URL/api/v1/health" 2>/dev/null || true)"
  web_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$WEB_URL/" 2>/dev/null || true)"
  if [[ "$api_code" == 200 && "$web_code" == 200 ]]; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || fail 'Services did not both become ready within 40 seconds; review the tagged service logs above.'
printf '\nFrontend: %s\nBackend:  %s\nAPI docs: %s/docs\n' "$WEB_URL" "$API_URL" "$API_URL"

while true; do
  kill -0 -- "-$APP_GROUP_PID" 2>/dev/null || fail 'A service stopped unexpectedly.'
  sleep 1
done
