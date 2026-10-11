#!/usr/bin/env bash
# Connects the GitHub App to a deployed GitHubRunnerSwitch without the private key going through chat, shell history
# or git. Run it in your own terminal, with AWS credentials for the account of the stack.
#
#   scripts/setup-github-app.sh <stack-name> [region]
#
# The stack must export the construct values as outputs named WebhookUrl and SecretArn (see examples/app.ts).
set -euo pipefail
STACK="${1:?usage: setup-github-app.sh <stack-name> [region]}"
REGION="${2:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
[ -n "$REGION" ] || { echo "Set the region (second argument or AWS_REGION)." >&2; exit 2; }
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
URL="$(out WebhookUrl)"; SECRET="$(out SecretArn)"
[ -n "$URL" ] && [ "$URL" != None ] && [ -n "$SECRET" ] && [ "$SECRET" != None ] || { echo "Outputs WebhookUrl/SecretArn not found in $STACK." >&2; exit 2; }
CURRENT="$(aws secretsmanager get-secret-value --secret-id "$SECRET" --query SecretString --output text)"
WEBHOOK_SECRET="$(printf '%s' "$CURRENT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["webhookSecret"])')"

cat <<MSG

1) Create a GitHub App (organization: Settings → Developer settings → GitHub Apps → New GitHub App)
   - Webhook: active · URL: $URL
     Webhook secret: $WEBHOOK_SECRET
   - Repository permissions: Administration (read & write), Actions (read & write), Variables (read & write), Metadata (read)
   - Organization permissions: Administration (read)   ← billing usage report
   - Subscribe to events: Workflow job · Where can it be installed: Only on this account
2) Generate a private key (.pem) and install the App on the repository only.

MSG
read -rp "App ID: " APP_ID
read -rp "Path to the downloaded .pem: " PEM
read -rp "Personal account only — fine-grained token with 'Plan: read' (leave empty for organizations): " -s BILLING_TOKEN; echo
[[ "$APP_ID" =~ ^[0-9]+$ ]] && [ -f "$PEM" ] || { echo "Invalid App ID or file; nothing changed." >&2; exit 2; }

TMP="$(mktemp)"; trap 'shred -u "$TMP" 2>/dev/null || rm -f "$TMP"' EXIT
APP_ID="$APP_ID" PEM="$PEM" BILLING_TOKEN="$BILLING_TOKEN" CURRENT="$CURRENT" python3 -c '
import json, os
s = json.loads(os.environ["CURRENT"])
s.update(appId=os.environ["APP_ID"], privateKey=open(os.environ["PEM"]).read())
if os.environ["BILLING_TOKEN"]: s["billingToken"] = os.environ["BILLING_TOKEN"]
print(json.dumps(s))' > "$TMP"
aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "file://$TMP" --query VersionId --output text >/dev/null
echo "Done: the function picks it up within 5 minutes. You can delete the .pem ($PEM)."
