#!/bin/bash
set -euo pipefail
# Root-owned forced-command entry point. Ignore arbitrary SSH command text.
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^(deploy|rollback)\ ([a-f0-9]{40}-[0-9]+-[0-9]+)$ ]]; then
  exec sudo -n /usr/bin/timeout --kill-after=30s 600s /usr/local/sbin/price-tracker-deploy "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
echo 'Only a validated deploy or rollback command is allowed.' >&2
exit 1
