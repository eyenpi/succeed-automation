#!/bin/bash
# Deploy workflow to n8n via API
# Usage: ./deploy.sh
#
# Set these env vars or edit below:
#   N8N_URL       — your n8n instance URL (no trailing slash)
#   N8N_API_KEY   — API key from n8n Settings > API
#   WORKFLOW_ID   — workflow ID from the n8n URL bar

N8N_URL="${N8N_URL:?Set N8N_URL (e.g. https://your-app.app.n8n.cloud)}"
N8N_API_KEY="${N8N_API_KEY:?Set N8N_API_KEY (from n8n Settings > API)}"
WORKFLOW_ID="${WORKFLOW_ID:?Set WORKFLOW_ID (from n8n workflow URL)}"

WORKFLOW_FILE="workflow/succeed_intake.json"

echo "Deploying $WORKFLOW_FILE to $N8N_URL/api/v1/workflows/$WORKFLOW_ID..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
  "$N8N_URL/api/v1/workflows/$WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @"$WORKFLOW_FILE")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "Deployed successfully."
else
  echo "Failed (HTTP $HTTP_CODE):"
  echo "$BODY"
  exit 1
fi
