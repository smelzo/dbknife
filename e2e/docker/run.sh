#!/usr/bin/env bash
# Runs e2e scripts in a Linux container, so that no window of the app reaches this Mac's desktop:
#   e2e/docker/run.sh copy-database.mjs [core.mjs …]
# The image (e2e/docker/Dockerfile) is built on the first run; the volume dbm-e2e-cache keeps the
# pnpm store, the Electron download and a working copy of each worktree (node_modules included).
# The test containers (dbm-test-*) must be running: the container reaches them on 127.0.0.1 as
# on the e2e machine, and runs docker exec into them through this machine's docker socket.
# DBM_* variables (e.g. DBM_MSSQL_HOST) are passed to the scripts. Screenshots land in e2e/output.
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: $0 <script.mjs> [more scripts…]" >&2; exit 64; }

root=$(cd "$(dirname "$0")/../.." && pwd)
image=dbknife-e2e
scripts=()
for s in "$@"; do
  s=${s#e2e/}
  [ -f "$root/e2e/$s" ] || { echo "no such script: e2e/$s" >&2; exit 64; }
  scripts+=("$s")
done

docker build -q -t "$image" "$root/e2e/docker" >/dev/null
mkdir -p "$root/e2e/output"
env_args=()
while IFS= read -r name; do env_args+=(-e "$name"); done < <(env | sed -n 's/^\(DBM_[A-Za-z0-9_]*\)=.*/\1/p')

exec docker run --rm --init \
  -v "$root:/src:ro" \
  -v "$root/e2e/output:/out" \
  -v dbm-e2e-cache:/cache \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e WORK_KEY="$(printf %s "$root" | shasum | cut -c1-12)" \
  ${env_args[@]+"${env_args[@]}"} \
  "$image" bash /src/e2e/docker/inside.sh "${scripts[@]}"
