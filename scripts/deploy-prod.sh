#!/bin/bash

#
# Deno deploy honors .gitignore when deploying.
#  deploying to prod uses config.yaml, but this file is not tracked by git (it is in .gitignore) for privacy.
#  to deploy, you have to copy config.yaml to a temp dir and deploy from there
#

set -euo pipefail

config_file="config.yaml"

if [[ ! -f "deno.json" ]]; then
  echo "error: deno.json file not found" >&2
  exit 1
fi

org=$(jq -r '.deploy["org"] // empty' deno.json) || org=""
app=$(jq -r '.deploy["app"] // empty' deno.json) || app=""
org=${org:-default_org}
app=${app:-default_app}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh [options] [-- <extra deno deploy args>]

Builds a temporary deploy directory that includes local config.yaml, then runs:
  deno deploy <temp-dir> --org <org> --app <app> --prod

EOF
}

if [[ -z "$org" || -z "$app" || -z "$config_file" ]]; then
  echo "error: --org, --app, and --config must be non-empty" >&2
  exit 1
fi

if [[ ! -f "$config_file" ]]; then
  echo "error: config file not found: $config_file" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# get a list of tracked files, subject to .gitignore, then pass them to rsync (but add --exclude='.gitignore')
git ls-files -z --cached --others --exclude-standard | \
rsync -a --from0 --files-from=- --exclude='.gitignore' "$repo_root/" "$tmp_dir/"

cp "$config_file" "$tmp_dir/config.yaml"

if [[ -f "$tmp_dir/.gitignore" ]]; then
  grep -v '^config\.yaml$' "$tmp_dir/.gitignore" >"$tmp_dir/.gitignore.tmp" || true
  echo "why is .gitignore in $tmp_dir ?"
  exit 1
fi

echo "------------------------------"
find $tmp_dir
echo "------------------------------"

echo "Deploying $app in $org using temp dir: $tmp_dir"
deno deploy "$tmp_dir" --org "$org" --app "$app" --prod
