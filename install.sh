#!/usr/bin/env bash
#
# Agentplate installer — clones (or updates) the repo and links the `agentplate` CLI
# onto your PATH via Bun. Requires Bun (https://bun.sh) and git.
#
#   curl -fsSL https://raw.githubusercontent.com/agentplate/agentplate/main/install.sh | bash
#
set -euo pipefail

REPO="${AGENTPLATE_REPO:-https://github.com/agentplate/agentplate.git}"
DEST="${AGENTPLATE_DIR:-$HOME/.agentplate-cli}"

info() { printf '  \033[38;5;208m▸\033[0m %s\n' "$1"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

command -v bun >/dev/null 2>&1 || { err "Bun is required: https://bun.sh"; exit 1; }
command -v git >/dev/null 2>&1 || { err "git is required."; exit 1; }

if [ -d "$DEST/.git" ]; then
  info "Updating Agentplate in $DEST"
  git -C "$DEST" pull --ff-only --quiet
else
  info "Cloning Agentplate into $DEST"
  git clone --depth 1 --quiet "$REPO" "$DEST"
fi

info "Installing dependencies"
( cd "$DEST" && bun install --silent )

info "Linking the agentplate CLI"
( cd "$DEST" && bun link >/dev/null 2>&1 || true )

printf '\n  \033[32m✓\033[0m Agentplate installed.\n'
printf '    Next: \033[1magentplate setup\033[0m in your project, then \033[1magentplate doctor\033[0m.\n'
