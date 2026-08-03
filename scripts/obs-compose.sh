#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
compose_file="${repo_root}/observability/docker-compose.yml"

if [[ -z "${DOCKER_HOST:-}" ]] && [[ ! -S /var/run/docker.sock ]] && [[ -S "${HOME}/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f "${compose_file}" "$@"
fi

if command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose -f "${compose_file}" "$@"
fi

echo "obs-compose: need Docker. Install Docker Desktop, or: brew install colima docker docker-compose && colima start" >&2
exit 1
