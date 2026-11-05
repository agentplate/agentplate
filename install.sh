#!/usr/bin/env bash
#
# Agentplate installer — clones (or updates) a pinned Agentplate release and links
# the `agentplate` CLI onto your PATH via Bun. Requires Bun (https://bun.sh) and git.
#
#   curl -fsSL https://raw.githubusercontent.com/agentplate/agentplate/main/install.sh | bash
#
# By default it installs the latest release tag (the highest stable vX.Y.Z), never
# the moving head of `main`. Environment overrides:
#   AGENTPLATE_VERSION  release to install, e.g. 1.7.0 or v1.7.0 (default: latest)
#   AGENTPLATE_REPO     git URL to install from
#   AGENTPLATE_DIR      checkout location (default: ~/.agentplate-cli)
#
# The whole script lives in main(), which runs only on the last line, so a
# truncated download never executes a partial script.

set -euo pipefail

info() { printf '  \033[38;5;208m▸\033[0m %s\n' "$1"; }
err() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }
die() {
  err "$1"
  exit 1
}

# Print the highest stable release tag (vMAJOR.MINOR.PATCH) published in $1.
latest_tag() {
  local tags
  tags="$(git ls-remote --tags --refs "$1" 'refs/tags/v*')" ||
    die "Could not list release tags from $1"
  printf '%s\n' "$tags" |
    sed -n 's#^.*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
    sort -t. -k1.2,1n -k2,2n -k3,3n |
    tail -n 1
}

main() {
  local repo="${AGENTPLATE_REPO:-https://github.com/agentplate/agentplate.git}"
  local dest="${AGENTPLATE_DIR:-$HOME/.agentplate-cli}"

  command -v bun >/dev/null 2>&1 || die "Bun is required: https://bun.sh"
  command -v git >/dev/null 2>&1 || die "git is required."

  local tag
  if [ -n "${AGENTPLATE_VERSION:-}" ]; then
    tag="v${AGENTPLATE_VERSION#v}"
  else
    tag="$(latest_tag "$repo")"
    [ -n "$tag" ] || die "No release tag (vX.Y.Z) found in $repo. Set AGENTPLATE_VERSION."
  fi

  if [ -d "$dest/.git" ]; then
    info "Updating Agentplate in $dest to $tag"
    git -C "$dest" fetch --quiet --depth 1 "$repo" "refs/tags/$tag:refs/tags/$tag" ||
      die "Could not fetch release $tag from $repo"
    git -C "$dest" checkout --quiet --detach "refs/tags/$tag" ||
      die "Could not check out $tag in $dest (local changes?)"
  else
    info "Cloning Agentplate $tag into $dest"
    git clone --quiet --depth 1 --branch "$tag" "$repo" "$dest" ||
      die "Could not clone release $tag from $repo"
  fi

  info "Installing dependencies"
  (cd "$dest" && bun install --frozen-lockfile --silent) ||
    die "bun install failed (lockfile out of date or registry unreachable)"

  info "Linking the agentplate CLI"
  (cd "$dest" && bun link) || die "bun link failed — the agentplate CLI is not on your PATH"

  printf '\n  \033[32m✓\033[0m Agentplate %s installed.\n' "$tag"
  if ! command -v agentplate >/dev/null 2>&1; then
    err "agentplate is not on PATH yet: add Bun's global bin dir (usually ~/.bun/bin) to PATH."
  fi
  printf '    Next: \033[1magentplate setup\033[0m in your project, then \033[1magentplate doctor\033[0m.\n'
}

main "$@"
