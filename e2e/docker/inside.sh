#!/usr/bin/env bash
# Runs inside the container started by run.sh: /src is the worktree (read-only), /cache the
# volume holding the pnpm store, the Electron download and the working copies, /out the
# worktree's e2e/output. Arguments: the e2e scripts to run.
set -uo pipefail

# the test servers on 127.0.0.1 as e2e/lib.mjs expects them, relayed to the host's published ports
for port in 33061 33062 33063 32222; do
  socat TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:$port &
done

# one working copy per worktree, kept between runs so node_modules is reused
work=/cache/work/$WORK_KEY
mkdir -p "$work"
exec 9>"$work.lock"
flock 9

rsync -a --delete --exclude=/.git --exclude=node_modules --exclude=/out --exclude='/out-*' --exclude=/dist \
  --exclude=/e2e/output --exclude=/helper/target /src/ "$work/"
cd "$work"
rm -rf e2e/output

step() { echo "--- $*"; }
step "pnpm install"
pnpm install --frozen-lockfile --store-dir /cache/pnpm-store --reporter=append-only >/tmp/install.log 2>&1 || { cat /tmp/install.log; exit 2; }
node node_modules/electron/install.js || exit 2
step "pnpm build"
pnpm build >/tmp/build.log 2>&1 || { cat /tmp/build.log; exit 2; }

failed=0
for script in "$@"; do
  step "node e2e/$script"
  xvfb-run -a -s '-screen 0 1920x1200x24' node "e2e/$script" || failed=$((failed + 1))
done

mkdir -p e2e/output
cp -a e2e/output/. /out/
exit $failed
