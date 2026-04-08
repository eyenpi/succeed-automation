#!/usr/bin/env node

// Automates Airtable base + table creation for the Succeed Intake pipeline.
// Usage: AIRTABLE_PAT=pat... AIRTABLE_WORKSPACE_ID=wsp... node setup/configure_airtable.js

const PAT = process.env.AIRTABLE_PAT;
const WORKSPACE_ID = process.env.AIRTABLE_WORKSPACE_ID;

if (!PAT || !WORKSPACE_ID) {
  console.error(
    "Missing env vars. Run with:\n  AIRTABLE_PAT=pat... AIRTABLE_WORKSPACE_ID=wsp... node setup/configure_airtable.js"
  );
  process.exit(1);
}

const API = "https://api.airtable.com/v0";

async function request(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`${method} ${path} failed (${res.status}):`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

function selectField(name, choices) {
  return {
    name,
    type: "singleSelect",
    options: { choices: choices.map((c) => ({ name: c })) },
  };
}

const fields = [
  // --- Intake (Set node) ---
  { name: "Raw Input", type: "multilineText" },
  { name: "From Email", type: "email" },
  selectField("Source", ["email", "form", "webhook", "manual"]),
  { name: "Timestamp", type: "dateTime", options: { timeZone: "utc", dateFormat: { name: "iso" }, timeFormat: { name: "24hour" } } },

  // --- Extraction ---
  selectField("Enquiry Category", [
    "provider_opportunity", "school_request", "student_request",
    "organisation_request", "spam", "unknown",
  ]),
  selectField("Sender Type", [
    "programme_provider", "school", "student", "organisation", "unknown",
  ]),
  { name: "Sender Name", type: "singleLineText" },
  { name: "Programme Name", type: "singleLineText" },
  { name: "Programme Topic", type: "singleLineText" },
  { name: "Age Range", type: "singleLineText" },
  { name: "Location", type: "singleLineText" },
  selectField("Format", ["in_person", "online", "hybrid", "unknown"]),
  { name: "Fee Text", type: "singleLineText" },
  { name: "Delivery Preference", type: "singleLineText" },
  { name: "Timeline", type: "singleLineText" },
  { name: "Contact Email", type: "email" },
  selectField("Intent", [
    "partnership", "listing", "information_request",
    "support_request", "spam", "unclear",
  ]),
  { name: "Summary", type: "multilineText" },
  { name: "Missing Fields", type: "multilineText" },

  // --- Validation ---
  selectField("Processing Status", [
    "ok", "spam", "spam_suspected", "extraction_failed",
  ]),
  selectField("Confidence Level", ["high", "medium", "low"]),
  { name: "Fee Numeric", type: "number", options: { precision: 2 } },
  { name: "Validation Flags", type: "multilineText" },

  // --- Scoring ---
  { name: "Priority Score", type: "number", options: { precision: 0 } },
  selectField("Priority Tier", [
    "high", "medium", "low", "minimal", "spam", "failed",
  ]),
  { name: "Score Breakdown", type: "multilineText" },
  { name: "Score Rationale", type: "multilineText" },

  // --- Routing ---
  selectField("Next Action", [
    "schedule_call", "request_info", "share_options",
    "manual_review", "archive",
  ]),
  { name: "Action Note", type: "multilineText" },
  { name: "Needs Review", type: "checkbox", options: { icon: "check", color: "yellowBright" } },
  { name: "Reply Questions", type: "multilineText" },

  // --- Reply ---
  { name: "Draft Follow-Up", type: "multilineText" },
];

async function createBase() {
  console.log('Creating base "Succeed"...');
  // Airtable requires at least one table when creating a base.
  // We create the Enquiries table inline with all fields.
  const base = await request("POST", "/meta/bases", {
    name: "Succeed",
    workspaceId: WORKSPACE_ID,
    tables: [
      {
        name: "Enquiries",
        fields,
      },
    ],
  });
  const baseId = base.id;
  const tableId = base.tables[0].id;
  console.log(`Base created: ${baseId}`);
  console.log(`Table created: ${tableId} (${base.tables[0].name}, ${fields.length} fields)`);
  return { baseId, tableId };
}

async function tryCreateView(baseId, tableId, name, filterSpec, sortSpec) {
  try {
    const res = await fetch(`${API}/meta/bases/${baseId}/tables/${tableId}/views`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, type: "grid" }),
    });
    if (res.ok) {
      const view = await res.json();
      console.log(`  View created: "${name}" (${view.id})`);
      if (filterSpec) console.log(`    Filter (set manually): ${filterSpec}`);
      if (sortSpec) console.log(`    Sort (set manually): ${sortSpec}`);
      return;
    }
  } catch {}
  // View creation not supported — log for manual setup
  console.log(`  View (create manually): "${name}"`);
  if (filterSpec) console.log(`    Filter: ${filterSpec}`);
  if (sortSpec) console.log(`    Sort: ${sortSpec}`);
}

async function main() {
  const { baseId, tableId } = await createBase();

  console.log("\nCreating views...");
  await tryCreateView(baseId, tableId, "All Enquiries", null, "Timestamp DESC");
  await tryCreateView(baseId, tableId, "High Priority", 'Priority Tier = "high"', "Priority Score DESC");
  await tryCreateView(baseId, tableId, "Needs Review", "Needs Review = checked", "Priority Score DESC");

  console.log("\n--- Configuration complete ---");
  console.log(`Base ID:  ${baseId}`);
  console.log(`Table ID: ${tableId}`);
  console.log("\nNext steps:");
  console.log("  1. Open the base in Airtable and set view filters/sorts");
  console.log("  2. Configure n8n Airtable credentials with the Base ID and table name");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
