#!/bin/sh
# piq installer — installs to ~/.local/share/piq and symlinks ~/.local/bin/piq
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mnapolitano89/piq/main/install.sh | sh
#   ./install.sh --local   # install from current local checkout

set -eu

REPO="${PIQ_REPO:-mnapolitano89/piq}"
REF="${PIQ_REF:-main}"
INSTALL_DIR="${PIQ_INSTALL_DIR:-$HOME/.local/share/piq}"
BIN_DIR="${PIQ_BIN_DIR:-$HOME/.local/bin}"
FROM_LOCAL=0

for arg in "$@"; do
  case "$arg" in
    --local) FROM_LOCAL=1 ;;
    -h|--help)
      printf "Usage: install.sh [--local]\n"
      printf "Env overrides: PIQ_INSTALL_DIR, PIQ_BIN_DIR, PIQ_REPO, PIQ_REF\n"
      exit 0
      ;;
    *)
      printf "install.sh: unknown option: %s\n" "$arg" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

if [ "$FROM_LOCAL" -eq 1 ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ ! -f "$SCRIPT_DIR/bin/piq.js" ] || [ ! -f "$SCRIPT_DIR/package.json" ]; then
    printf "install.sh: --local must be run from a piq checkout\n" >&2
    exit 1
  fi
  SRC_DIR="$SCRIPT_DIR"
else
  if ! command -v curl >/dev/null 2>&1; then
    printf "install.sh: curl is required\n" >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    printf "install.sh: tar is required\n" >&2
    exit 1
  fi
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/piq-install.XXXXXX")
  TARBALL_URL="https://codeload.github.com/${REPO}/tar.gz/${REF}"
  printf "Downloading piq (%s@%s)...\n" "$REPO" "$REF" >&2
  curl -fsSL "$TARBALL_URL" | tar -xz -C "$TMP_DIR"
  SRC_DIR=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/bin/piq.js" ]; then
    printf "install.sh: downloaded archive did not contain bin/piq.js\n" >&2
    exit 1
  fi
fi

rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/lib"
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/lib"
cp "$SRC_DIR/package.json" "$INSTALL_DIR/package.json"
[ -f "$SRC_DIR/LICENSE" ] && cp "$SRC_DIR/LICENSE" "$INSTALL_DIR/LICENSE"
[ -f "$SRC_DIR/README.md" ] && cp "$SRC_DIR/README.md" "$INSTALL_DIR/README.md"
cp "$SRC_DIR/bin/piq.js" "$INSTALL_DIR/bin/piq.js"
cp "$SRC_DIR/lib/"*.js "$INSTALL_DIR/lib/"
chmod +x "$INSTALL_DIR/bin/piq.js"

ln -sf "$INSTALL_DIR/bin/piq.js" "$BIN_DIR/piq"

printf "Installed piq -> %s/piq\n" "$BIN_DIR" >&2

case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf "Note: %s is not on your PATH. Add to your shell config:\n" "$BIN_DIR" >&2
    printf "  export PATH=\"%s:\$PATH\"\n" "$BIN_DIR" >&2
    ;;
esac

printf "Optional per-pane shell hook (exit codes + cwd breadcrumbs):\n" >&2
printf "  piq --init\n" >&2
