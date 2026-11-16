#!/bin/sh
# Builds dbknife-sqlite for the four server platforms into bin/remote/, with its notices.
# Needs the four rustup targets below, plus zig and cargo-zigbuild for the static Linux builds.
set -eu
cd "$(dirname "$0")"
out=../bin/remote
mkdir -p "$out"
# The executables go into a public repository: no path of the build machine in them.
# Of two prefixes that match, rustc applies the last one. The flags are separated by the
# byte 037, not by spaces, so that a path may contain them.
CARGO_ENCODED_RUSTFLAGS=$(printf -- '--remap-path-prefix=%s=~\037--remap-path-prefix=%s=helper' "$HOME" "$(pwd -P)")
export CARGO_ENCODED_RUSTFLAGS
# Functions and virtual tables that the app's own SQLite (node:sqlite) has and the build of
# libsqlite3-sys leaves out: a view or a generated column may use them.
export LIBSQLITE3_FLAGS="SQLITE_ENABLE_MATH_FUNCTIONS SQLITE_ENABLE_PERCENTILE SQLITE_ENABLE_GEOPOLY"

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
