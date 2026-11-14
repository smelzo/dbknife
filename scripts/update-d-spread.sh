#!/bin/sh
# Copies the d-spread binaries (reading and writing spreadsheets, run as separate processes) into
# bin/<platform>-<arch>/, with their version and license notice.
# Source: the d-spread repo, ../d-suite/d-cli/d-spread from the repo root, or D_SPREAD_DIR.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
src=${D_SPREAD_DIR:-$root/../d-suite/d-cli/d-spread}
[ -d "$src/lib/bin" ] || { echo "update-d-spread: $src/lib/bin not found (set D_SPREAD_DIR)" >&2; exit 1; }
dest=$root/bin

copy() { # source suffix, destination folder, file extension, required
    # both programs or neither: a platform with only one of them would offer half the features
    for program in d-spread d-spread-write; do
        from=$src/lib/bin/$program-$1$3
        [ -f "$from" ] && continue
        if [ "$4" = required ]; then
            echo "update-d-spread: $from is missing" >&2
            exit 1
        fi
        echo "update-d-spread: warning: $from is missing, $2 skipped" >&2
        return 0
    done
    mkdir -p "$dest/$2"
    for program in d-spread d-spread-write; do
        /bin/cp -f "$src/lib/bin/$program-$1$3" "$dest/$2/$program$3"
        [ -n "$3" ] || chmod 755 "$dest/$2/$program"
        echo "$dest/$2/$program$3"
    done
}

copy macos-arm64 darwin-arm64 '' required
copy macos-x86_64 darwin-x64 '' optional
copy linux-x86_64 linux-x64 '' required
copy windows-x86_64 win32-x64 .exe optional
copy windows-arm64 win32-arm64 .exe optional

/bin/cp -f "$src/lib/VERSION" "$dest/VERSION"
# d-spread is MIT (LICENSE); NOTICE names the GridCraft code it contains, MIT or Apache-2.0
for file in NOTICE LICENSE LICENSE-MIT LICENSE-APACHE; do
    [ "$file" = NOTICE ] || echo
    cat "$src/$file"
done > "$dest/d-spread-LICENSE.txt"
echo "d-spread $(cat "$dest/VERSION")"
