#!/bin/sh
# Builds dbknife-sqlite for the four server platforms into bin/remote/, with its notices.
# Needs the four rustup targets below, plus zig and cargo-zigbuild for the static Linux builds.
set -eu
cd "$(dirname "$0")"
out=../bin/remote
mkdir -p "$out"

# build <cargo subcommand> <target> <platform>-<arch>
build() {
  cargo "$1" --release --locked --target "$2"
  install -m 755 "target/$2/release/dbknife-sqlite" "$out/dbknife-sqlite-$3"
}

build build aarch64-apple-darwin darwin-arm64
build build x86_64-apple-darwin darwin-x64
build zigbuild x86_64-unknown-linux-musl linux-x64
build zigbuild aarch64-unknown-linux-musl linux-arm64
cp NOTICE "$out/NOTICE.txt"
