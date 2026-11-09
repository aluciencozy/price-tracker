#!/bin/bash
set -euo pipefail
umask 027
[[ $EUID == 0 && $# == 2 ]] || exit 1
action=$1
release_id=$2
[[ $action == deploy || $action == rollback ]] || exit 1
[[ $release_id =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 1

base=/srv/price-tracker
release="$base/releases/$release_id"
state=/var/lib/price-tracker-deploy
node_bin=/opt/node-v24.22.1-linux-x64/bin
origin=https://price-tracker-ibrahim.northcentralus.cloudapp.azure.com
exec 9>/run/lock/price-tracker-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
install -d -m 700 "$state"

activate() {
  # The parent directory is root-owned; replace a symlink atomically.
  ln -sfnT "$1" "$base/current.next"
  mv -Tf "$base/current.next" "$base/current"
  systemctl restart price-tracker-api
}
ready() {
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:4000/api/ready |
        "$node_bin/node" -e 'let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{try{const b=JSON.parse(s);process.exit(b.status==="ready"&&b.database==="connected"?0:1)}catch{process.exit(1)}})'; then
      return 0
    fi
    sleep 2
  done
  return 1
}
restore() {
  local previous
  previous=$(cat "$state/$release_id.previous")
  [[ $previous == "$base/releases/"* && -d $previous ]] || return 1
  activate "$previous"
  ready
}
if [[ $action == rollback ]]; then
  [[ $(readlink -f "$base/current") == "$release" ]] || { echo 'Rollback refused: another release is current.' >&2; exit 1; }
  restore
  echo 'Previous release restored and ready.'
  exit 0
fi

[[ -L $base/current && ! -e $release ]] || { echo 'Current symlink missing or release already exists.' >&2; exit 1; }
readlink -f "$base/current" > "$state/$release_id.previous"
install -d -o price-tracker -g price-tracker -m 755 "$release"
# Extract as the application user. Dependencies were installed on the Linux runner.
runuser -u price-tracker -- /bin/sh -c 'umask 022; exec tar -xzf - -C "$1" --no-same-owner --no-same-permissions' sh "$release"
[[ -f $release/apps/api/dist/server.js && -f $release/apps/web/dist/index.html && -d $release/node_modules/mongoose ]]
cd "$release"
# Validate config before switching, without logging environment values.
if ! runuser -u price-tracker -- "$node_bin/node" --env-file=/etc/price-tracker/api.env \
    --input-type=module -e 'import {loadConfig} from "./apps/api/dist/config.js";loadConfig();' \
    > "$state/$release_id.config.log" 2>&1; then
  echo 'API configuration validation failed; current release unchanged.' >&2
  exit 1
fi
switched=false
recover() {
  local result=$?
  trap - EXIT
  if [[ $result != 0 && $switched == true ]]; then
    if restore; then echo 'Failed release rolled back; previous API is ready.' >&2;
    else echo 'Rollback needs operator attention; check the service privately.' >&2; fi
  fi
  exit "$result"
}
trap recover EXIT
trap 'exit 143' TERM HUP INT
switched=true
activate "$release"
ready
# Check the public TLS endpoint, exact web release, and API before success.
runuser -u price-tracker -- "$node_bin/node" "$release/scripts/verify-vm-release.mjs" "$origin" "$release_id"
echo "Deployed $release_id; API and HTTPS release verified."
