#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
OS_RELEASE=/etc/os-release

log() { printf '\n\033[1;36m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
node_home_candidate="$(printf '%s\n' "$HOME"/.local/share/bioeconomy/node-v*/bin 2>/dev/null | sort -Vr | head -n1)"
if [[ -x "$node_home_candidate/node" ]]; then export PATH="$node_home_candidate:$PATH"; fi

[[ -f "$OS_RELEASE" ]] || fail 'Cannot identify this Linux distribution (/etc/os-release missing).'
# shellcheck disable=SC1091
. "$OS_RELEASE"
DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"

install_packages() {
  local packages=(git curl ca-certificates iproute2 nodejs npm python postgresql)
  if [[ "$DISTRO_ID" == arch || " $DISTRO_LIKE " == *' arch '* ]]; then
    have pacman || fail 'Arch Linux requires pacman.'
    if [[ $EUID -eq 0 ]]; then
      pacman -S --needed --noconfirm "${packages[@]}" || fail 'pacman could not install prerequisites.'
    elif have sudo; then
      sudo pacman -S --needed "${packages[@]}" || fail 'pacman could not install prerequisites.'
    else
      fail 'Install git, curl, ca-certificates, iproute2, nodejs, npm, python, and postgresql with pacman (sudo required).'
    fi
  elif [[ "$DISTRO_ID" == ubuntu || "$DISTRO_ID" == debian || " $DISTRO_LIKE " == *' debian '* ]]; then
    have apt-get || fail 'Ubuntu/Debian requires apt-get.'
    local apt=(apt-get)
    if [[ $EUID -ne 0 ]]; then have sudo || fail 'Install prerequisites with apt (sudo required).'; apt=(sudo apt-get); fi
    "${apt[@]}" update
    DEBIAN_FRONTEND=noninteractive "${apt[@]}" install -y git curl ca-certificates iproute2 nodejs npm python3 python3-venv python3-dev postgresql postgresql-client
  else
    fail "Unsupported Linux distribution '$DISTRO_ID'. Supported: Arch, Ubuntu, Debian."
  fi
}

log "Operating system: ${PRETTY_NAME:-$DISTRO_ID}; architecture: $(uname -m); Bash ${BASH_VERSION}"
for tool in git node npm python3; do
  have "$tool" || { log "Installing missing system prerequisites through the official $DISTRO_ID package manager."; install_packages; break; }
done
for tool in git node npm python3; do have "$tool" || fail "Required command '$tool' is still missing."; done

node_version="$(node --version | sed 's/^v//')"
IFS=. read -r node_major node_minor _ <<< "$node_version"
[[ "$node_major" =~ ^[0-9]+$ && "$node_minor" =~ ^[0-9]+$ ]] || fail "Could not parse Node.js version '$node_version'."
if ! { (( node_major == 20 && node_minor >= 19 )) || (( node_major == 22 && node_minor >= 12 )) || (( node_major > 22 && node_major % 2 == 0 )); }; then
  log "Node.js $node_version is outside Vite's supported LTS range; installing official Node.js 22 LTS for this user."
  node_arch="$(uname -m)"
  case "$node_arch" in x86_64) node_arch=x64 ;; aarch64|arm64) node_arch=arm64 ;; armv7l) node_arch=armv7l ;; *) fail "No official Node.js 22 binary is configured for architecture $node_arch." ;; esac
  node_version="$(python3 -c 'import json,urllib.request; print(next(x["version"] for x in json.load(urllib.request.urlopen("https://nodejs.org/dist/index.json")) if x.get("lts") and x["version"].startswith("v22.")))')" || fail 'Could not retrieve the official Node.js release index.'
  node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
  node_temp="$(mktemp -d)"
  trap 'rm -rf -- "${node_temp:-}"' EXIT
  curl -fsS "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$node_temp/$node_archive" || fail 'Could not download official Node.js from nodejs.org.'
  curl -fsS "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$node_temp/SHASUMS256.txt" || fail 'Could not download Node.js checksums.'
  (cd "$node_temp" && grep -F "  $node_archive" SHASUMS256.txt | sha256sum -c -) || fail 'Official Node.js checksum verification failed.'
  node_home="$HOME/.local/share/bioeconomy/node-${node_version}"
  mkdir -p -- "$(dirname -- "$node_home")"
  if [[ ! -x "$node_home/bin/node" ]]; then
    stage="$node_temp/node-stage"
    mkdir -p -- "$stage"
    tar -xJf "$node_temp/$node_archive" -C "$stage" --strip-components=1
    mv -- "$stage" "$node_home"
  fi
  rm -rf -- "$node_temp"
  trap - EXIT
  export PATH="$node_home/bin:$PATH"
  node_version="$(node --version | sed 's/^v//')"
  log "Installed checksum-verified Node.js $node_version under $node_home."
fi
log "Git $(git --version); Node.js $node_version; npm $(npm --version); Python $(python3 --version | awk '{print $2}')"

if ! have uv; then
  if have pacman; then
    log 'Installing uv from the official distribution repositories.'
    if [[ $EUID -eq 0 ]]; then pacman -S --needed --noconfirm uv || fail 'Could not install uv with pacman.'
    elif have sudo; then sudo pacman -S --needed uv || fail 'Could not install uv with pacman.'
    else fail 'Install uv using pacman or the official guide: https://docs.astral.sh/uv/getting-started/installation/'; fi
  else
    log 'Installing pipx from the official distribution repository, then installing uv from PyPI.'
    apt=(apt-get); [[ $EUID -eq 0 ]] || apt=(sudo apt-get)
    "${apt[@]}" install -y pipx || fail 'Could not install pipx from the official apt repository.'
    if ! have pipx && [[ -x "$HOME/.local/bin/pipx" ]]; then export PATH="$HOME/.local/bin:$PATH"; fi
    have pipx || fail 'pipx is unavailable after installation.'
    pipx install uv || fail 'Could not install uv from PyPI through pipx.'
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi
have uv || fail 'uv is unavailable. Install from https://docs.astral.sh/uv/getting-started/installation/ and rerun.'
log "uv $(uv --version)"

if ! have psql || ! have pg_isready; then
  log 'PostgreSQL client/service tools are not installed; installing PostgreSQL.'
  install_packages
fi
log "PostgreSQL client: $(psql --version)"

log 'Checking PostgreSQL service.'
if have systemctl; then
  mapfile -t postgres_units < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '$1 ~ /^postgresql(@.*)?\.service$/ {print $1}')
  if ((${#postgres_units[@]} == 0)); then
    log 'No PostgreSQL service unit was found; installing the distro PostgreSQL server package.'
    install_packages
    mapfile -t postgres_units < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '$1 ~ /^postgresql(@.*)?\.service$/ {print $1}')
  fi
  if ((${#postgres_units[@]})); then
    running=false
    for unit in "${postgres_units[@]}"; do
      if systemctl is-active --quiet "$unit"; then running=true; break; fi
    done
    if [[ "$running" == false ]]; then
      if [[ "$DISTRO_ID" == arch && -x /usr/bin/initdb && ! -s /var/lib/postgres/data/PG_VERSION ]]; then
        log 'Initializing the empty Arch PostgreSQL data directory.'
        if [[ $EUID -eq 0 ]]; then su - postgres -c 'initdb -D /var/lib/postgres/data' || fail 'Arch initdb failed.'
        elif have sudo; then sudo -u postgres initdb -D /var/lib/postgres/data || fail 'Arch initdb failed.'
        else fail 'Initialize Arch PostgreSQL with: sudo -u postgres initdb -D /var/lib/postgres/data'; fi
      fi
      unit="${postgres_units[0]}"
      log "Starting PostgreSQL service $unit."
      if [[ $EUID -eq 0 ]]; then systemctl start "$unit" || fail "Could not start $unit."
      elif have sudo; then sudo systemctl start "$unit" || fail "Could not start $unit."
      else fail "Start PostgreSQL with: sudo systemctl start $unit"; fi
    fi
  else
    fail 'PostgreSQL server service was not registered after package installation.'
  fi
fi

if [[ ! -e "$BACKEND/.env" ]]; then
  [[ -f "$BACKEND/.env.example" ]] || fail 'backend/.env.example is missing.'
  cp -- "$BACKEND/.env.example" "$BACKEND/.env"
  log 'Created backend/.env from the placeholder-only example; edit DATABASE_URL and any provider credentials you need.'
else
  log 'Preserved existing backend/.env.'
fi
if [[ ! -e "$FRONTEND/.env" ]]; then
  cp -- "$FRONTEND/.env.example" "$FRONTEND/.env"
  log 'Created frontend/.env from .env.example.'
else
  log 'Preserved existing frontend/.env.'
fi

log 'Synchronizing backend dependencies from uv.lock.'
(cd "$BACKEND" && uv sync --locked --python 3.14) || fail 'uv sync failed; check Python 3.14 availability and backend/uv.lock.'
log 'Validating backend import and FastAPI app.'
(cd "$BACKEND" && uv run --locked python -c 'from backend.main import app; print("FastAPI import: OK (" + app.title + ")")') || fail 'Backend import failed.'

log 'Installing frontend dependencies from package-lock.json.'
(cd "$FRONTEND" && npm ci) || fail 'npm ci failed; package-lock.json must match package.json.'
log 'Validating frontend production build (includes TypeScript project checks).'
(cd "$FRONTEND" && npm run build) || fail 'Frontend build failed.'

log 'Checking/creating only the named development database and applying Alembic migrations.'
(cd "$BACKEND" && uv run --locked python "$SCRIPT_DIR/dev_env.py" ensure-dev-db) || fail 'Database setup failed; see the safe manual PostgreSQL steps in README.md.'
(cd "$BACKEND" && uv run --locked alembic upgrade head) || fail 'Alembic migration failed; no database was dropped or reset.'

log 'Setup complete. Run ./scripts/start.sh to launch the frontend and API.'
printf 'Frontend: http://127.0.0.1:5173\nBackend:  http://127.0.0.1:49173\nAPI docs: http://127.0.0.1:49173/docs\n'
