#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root.' >&2; exit 1; }
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# This directory is extracted only after the pinned manifest signature and
# installer digest have been verified by bootstrap.py.
"$root/updater/install.sh" --install-host "$root/updater/updater-linux-amd64"
updater wyvern capabilities >/dev/null
updater wyvern install --manifest "$root/wyvern-release.json"
printf '%s\n' 'Wyvern installed. Run sudo updater tui to connect Kernel and configure Adapters.'
