#!/usr/bin/env bash
# Let Gmail push mailbox changes to the server (see convex/gmail/watch.ts).
#
# Creates the Pub/Sub topic and its push subscription in the Google Cloud
# project that owns the Gmail OAuth client, lets Gmail publish to the topic,
# stores the topic and the push secret in the Convex deployment, and starts
# a watch on every connected mailbox. Safe to run again: every step is
# idempotent, and an existing secret is kept.
#
# Needs: gcloud signed in (`gcloud auth login`), and the Convex deployment
# selected in packages/convex (.env.local).
set -euo pipefail

# This gcloud SDK needs Python 3.11 or older; the default python3 is newer.
export CLOUDSDK_PYTHON=${CLOUDSDK_PYTHON:-/opt/homebrew/bin/python3.11}

cd "$(dirname "$0")/.."

TOPIC=${TOPIC:-whisk-gmail}
SUBSCRIPTION=${SUBSCRIPTION:-whisk-gmail-push}

client_id=$(npx convex env get GMAIL_CLIENT_ID)
site_url=$(npx convex env get CONVEX_SITE_URL)
project_number=${client_id%%-*}
project=$(gcloud projects list --filter="projectNumber=${project_number}" --format="value(projectId)")
if [[ -z "$project" ]]; then
  echo "No Google Cloud project with number ${project_number} is visible to this gcloud account." >&2
  exit 1
fi
echo "project ${project}, server ${site_url}"

secret=$(npx convex env get GMAIL_PUSH_TOKEN 2>/dev/null || true)
if [[ -z "$secret" ]]; then
  secret=$(openssl rand -hex 24)
  npx convex env set GMAIL_PUSH_TOKEN "$secret"
fi

gcloud services enable pubsub.googleapis.com --project "$project"
gcloud pubsub topics describe "$TOPIC" --project "$project" >/dev/null 2>&1 ||
  gcloud pubsub topics create "$TOPIC" --project "$project"
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --project "$project" \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher >/dev/null
endpoint="${site_url}/gmail/push?token=${secret}"
if gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project "$project" >/dev/null 2>&1; then
  gcloud pubsub subscriptions modify-push-config "$SUBSCRIPTION" --project "$project" --push-endpoint="$endpoint"
else
  gcloud pubsub subscriptions create "$SUBSCRIPTION" --project "$project" --topic "$TOPIC" \
    --push-endpoint="$endpoint" --ack-deadline=10 --message-retention-duration=10m --expiration-period=never
fi

npx convex env set GMAIL_PUBSUB_TOPIC "projects/${project}/topics/${TOPIC}"
npx convex run gmail/watch:renewAll
echo "done: Gmail now pushes changes to ${site_url}/gmail/push"
