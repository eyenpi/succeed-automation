#!/usr/bin/env node
// ============================================================
// End-to-end test runner for the Succeed Intake System.
//
// Modes:
//   node test/run_e2e.js --send          Send inputs to n8n + evaluate Airtable results
//   node test/run_e2e.js --evaluate      Evaluate existing Airtable results only
//   node test/run_e2e.js --clean         Delete all Airtable records, then send + evaluate
//
// Environment variables (or .env file):
//   AIRTABLE_PAT       — Airtable Personal Access Token
//   AIRTABLE_BASE_ID   — Airtable Base ID
//   AIRTABLE_TABLE_ID  — Airtable Table ID
//   N8N_WEBHOOK_URL    — n8n webhook URL (required for --send mode)
// ============================================================

const fs = require("fs");
const path = require("path");

// --- Load .env if present ---

const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// --- Config ---

const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;

// --- Parse CLI args ---

const args = process.argv.slice(2);
const MODE_SEND = args.includes("--send") || args.includes("--clean");
const MODE_CLEAN = args.includes("--clean");
const DELAY_MS = parseInt(args.find((a) => a.startsWith("--delay="))?.split("=")[1] || "3000", 10);

if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) {
  console.error("Missing AIRTABLE_PAT, AIRTABLE_BASE_ID, or AIRTABLE_TABLE_ID.");
  console.error("Set them as environment variables or in a .env file.");
  process.exit(1);
}

if (MODE_SEND && !N8N_WEBHOOK_URL) {
  console.error("Missing N8N_WEBHOOK_URL (required for --send mode).");
  console.error("Add a Webhook trigger to your n8n workflow and set the URL.");
  process.exit(1);
}

// --- Helpers ---

async function airtableFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_PAT}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable API ${res.status}: ${body}`);
  }
  return res.json();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Airtable Operations ---

async function fetchAllRecords() {
  let all = [];
  let offset = null;
  do {
    const url = offset ? `${AIRTABLE_API}?offset=${offset}` : AIRTABLE_API;
    const data = await airtableFetch(url);
    all = all.concat(data.records);
    offset = data.offset;
  } while (offset);
  return all;
}

async function deleteAllRecords() {
  const records = await fetchAllRecords();
  if (records.length === 0) {
    console.log("  No records to delete.");
    return;
  }
  // Airtable allows deleting 10 at a time
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const ids = batch.map((r) => `records[]=${r.id}`).join("&");
    await airtableFetch(`${AIRTABLE_API}?${ids}`, { method: "DELETE" });
    process.stdout.write(`  Deleted ${Math.min(i + 10, records.length)}/${records.length}\r`);
  }
  console.log(`  Deleted ${records.length} records.              `);
}

// --- Send Input to n8n ---

async function sendToWorkflow(input) {
  const payload = {
    raw_message: input.raw_message,
    from_email: input.from_email || null,
    source: input.source || "manual",
  };

  const res = await fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`n8n webhook ${res.status}: ${body}`);
  }
  return res.json().catch(() => ({}));
}

// --- Wait for Record in Airtable ---

async function waitForRecord(rawMessage, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const records = await fetchAllRecords();
    const match = records.find(
      (r) => r.fields["Raw Input"] === rawMessage
    );
    if (match) return match;
    await sleep(2000);
  }
  return null;
}

// --- Evaluation ---

// Map from Airtable field names to expected output field names
const FIELD_MAP = {
  "Enquiry Category": "enquiry_category",
  "Sender Type": "sender_type",
  "Programme Topic": "programme_topic",
  "Age Range": "target_age_range",
  "Location": "location",
  "Format": "format",
  "Fee Text": "fee_text",
  "Contact Email": "contact_email",
  "Intent": "intent",
  "Processing Status": "processing_status",
  "Confidence Level": "confidence_level",
  "Fee Numeric": "fee_numeric",
  "Priority Score": "expected_score",
  "Priority Tier": "expected_tier",
  "Next Action": "expected_action",
  "Needs Review": "needs_review",
  "Action Note": "expected_action_note",
  // LLM Evaluation fields
  "Eval Status": "eval_status",
  "Eval Spam": "eval_spam_verdict",
  "Eval Institution": "eval_institution_verdict",
  "Eval Fee": "eval_fee_verdict",
  "Eval Audience": "eval_audience_verdict",
  "Rule Score": "rule_score",
  "Rule Tier": "rule_tier",
  "Rule Action": "rule_action",
};

// Eval verdict fields use WARN severity (LLM outputs vary)
const EVAL_VERDICT_FIELDS = new Set([
  "eval_spam_verdict",
  "eval_institution_verdict",
  "eval_fee_verdict",
  "eval_audience_verdict",
]);

function evaluateRecord(actual, expected) {
  const issues = [];
  const fields = actual.fields;

  for (const [airtableField, expectedKey] of Object.entries(FIELD_MAP)) {
    if (!(expectedKey in expected)) continue; // skip fields not in expected

    const actualVal = fields[airtableField];
    const expectedVal = expected[expectedKey];

    // Needs Review: Airtable returns undefined for false checkboxes
    if (expectedKey === "needs_review") {
      const actualBool = !!actualVal;
      if (actualBool !== expectedVal) {
        issues.push({
          field: airtableField,
          expected: expectedVal,
          actual: actualBool,
          severity: "minor",
        });
      }
      continue;
    }

    // Score: allow +/- 5 tolerance (rule score or priority score)
    if ((expectedKey === "expected_score" || expectedKey === "rule_score") && typeof expectedVal === "number") {
      const diff = Math.abs((actualVal || 0) - expectedVal);
      if (diff > 5) {
        issues.push({
          field: airtableField,
          expected: expectedVal,
          actual: actualVal || 0,
          severity: diff > 15 ? "major" : "minor",
        });
      }
      continue;
    }

    // Fee numeric: allow tolerance for different parsing
    if (expectedKey === "fee_numeric" && typeof expectedVal === "number") {
      if (actualVal && Math.abs(actualVal - expectedVal) > 1) {
        issues.push({
          field: airtableField,
          expected: expectedVal,
          actual: actualVal,
          severity: "minor",
        });
      }
      continue;
    }

    // Reply draft: just check NO_RESPONSE vs has content
    if (expectedKey === "reply_draft") {
      continue; // handled separately
    }

    // String comparison (case-insensitive for enums)
    if (expectedVal !== null && expectedVal !== undefined) {
      const a = String(actualVal || "").toLowerCase().trim();
      const e = String(expectedVal).toLowerCase().trim();
      if (a !== e) {
        // Eval verdict fields use WARN severity (LLM non-determinism)
        const isEvalVerdict = EVAL_VERDICT_FIELDS.has(expectedKey);
        const isCritical =
          !isEvalVerdict && (
            expectedKey === "processing_status" ||
            expectedKey === "expected_action" ||
            expectedKey === "expected_tier"
          );
        issues.push({
          field: airtableField,
          expected: expectedVal,
          actual: actualVal || "(empty)",
          severity: isCritical ? "major" : "minor",
        });
      }
    }
  }

  // Check reply_draft: NO_RESPONSE vs actual content
  if ("reply_draft" in expected) {
    const actualDraft = fields["Draft Follow-Up"] || "";
    if (expected.reply_draft === "NO_RESPONSE") {
      if (actualDraft && actualDraft !== "NO_RESPONSE") {
        issues.push({
          field: "Draft Follow-Up",
          expected: "NO_RESPONSE",
          actual: `"${actualDraft.slice(0, 50)}..."`,
          severity: "minor",
        });
      }
    } else if (expected.reply_draft !== "NO_RESPONSE") {
      if (!actualDraft || actualDraft === "NO_RESPONSE" || actualDraft === "DRAFT_FAILED") {
        issues.push({
          field: "Draft Follow-Up",
          expected: "(AI-generated draft)",
          actual: actualDraft || "(empty)",
          severity: "major",
        });
      }
    }
  }

  return issues;
}

function verdictFromIssues(issues) {
  if (issues.length === 0) return "PASS";
  const hasMajor = issues.some((i) => i.severity === "major");
  return hasMajor ? "FAIL" : "WARN";
}

// --- Report ---

function printReport(results) {
  const COL = { PASS: "\x1b[32m", FAIL: "\x1b[31m", WARN: "\x1b[33m", RESET: "\x1b[0m", DIM: "\x1b[2m" };

  console.log("\n" + "=".repeat(80));
  console.log("EVALUATION REPORT");
  console.log("=".repeat(80));

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let missingCount = 0;

  for (const r of results) {
    if (!r.found) {
      missingCount++;
      console.log(`\n${COL.FAIL}[MISSING]${COL.RESET} #${r.id} ${r.name}`);
      console.log(`  Record not found in Airtable.`);
      continue;
    }

    const verdict = verdictFromIssues(r.issues);
    const col = COL[verdict];
    if (verdict === "PASS") passCount++;
    else if (verdict === "WARN") warnCount++;
    else failCount++;

    console.log(`\n${col}[${verdict}]${COL.RESET} #${r.id} ${r.name}`);
    for (const issue of r.issues) {
      const sev = issue.severity === "major" ? COL.FAIL : COL.WARN;
      console.log(
        `  ${sev}${issue.severity.toUpperCase()}${COL.RESET} ${issue.field}: expected ${COL.DIM}${issue.expected}${COL.RESET}, got ${COL.DIM}${issue.actual}${COL.RESET}`
      );
    }
  }

  console.log("\n" + "-".repeat(80));
  const total = results.length;
  console.log(
    `${COL.PASS}${passCount} PASS${COL.RESET}  ${COL.WARN}${warnCount} WARN${COL.RESET}  ${COL.FAIL}${failCount} FAIL${COL.RESET}  ${missingCount} MISSING  / ${total} total`
  );
  console.log("-".repeat(80));

  return failCount === 0 && missingCount === 0 ? 0 : 1;
}

// --- Main ---

async function main() {
  // Load test data (single merged file for all inputs and expected outputs)
  const inputsPath = path.resolve(__dirname, "inputs.json");
  const expectedPath = path.resolve(__dirname, "expected_outputs.json");
  const allInputs = JSON.parse(fs.readFileSync(inputsPath, "utf8"));
  const allExpected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

  console.log(`Loaded ${allInputs.length} inputs, ${allExpected.length} expected outputs.`);

  // Clean mode: delete all records first
  if (MODE_CLEAN) {
    console.log("\nCleaning Airtable...");
    await deleteAllRecords();
  }

  // Send mode: send inputs to n8n workflow
  if (MODE_SEND) {
    console.log(`\nSending ${allInputs.length} inputs to n8n (delay: ${DELAY_MS}ms)...\n`);
    for (let i = 0; i < allInputs.length; i++) {
      const input = allInputs[i];
      process.stdout.write(`  [${i + 1}/${allInputs.length}] ${input.name}...`);
      try {
        await sendToWorkflow(input);
        console.log(" sent");
      } catch (e) {
        console.log(` ERROR: ${e.message}`);
      }
      if (i < allInputs.length - 1) await sleep(DELAY_MS);
    }

    // Wait for the last record to be processed
    console.log("\nWaiting for workflow processing to complete...");
    await sleep(Math.max(DELAY_MS * 2, 5000));
  }

  // Fetch all Airtable records
  console.log("\nFetching Airtable records...");
  const records = await fetchAllRecords();
  console.log(`  Found ${records.length} records.`);

  // Match records to expected outputs
  const results = [];
  const usedRecordIds = new Set();

  for (const exp of allExpected) {
    // Find the matching input
    const input = allInputs.find((i) => i.id === exp.id);
    const rawMessage = input?.raw_message || "";
    const timestamp = input?.timestamp || "";

    // Find matching Airtable record by raw_message (primary) or timestamp (fallback)
    let match = records.find(
      (r) => !usedRecordIds.has(r.id) && r.fields["Raw Input"] === rawMessage
    );

    // Fallback: match empty/whitespace inputs by timestamp
    if (!match && (!rawMessage || !rawMessage.trim())) {
      match = records.find(
        (r) =>
          !usedRecordIds.has(r.id) &&
          (!r.fields["Raw Input"] || !r.fields["Raw Input"].trim()) &&
          r.fields["Timestamp"]?.startsWith(timestamp.replace("Z", ""))
      );
    }

    // Fallback: match by timestamp for any unmatched record
    if (!match && timestamp) {
      match = records.find(
        (r) =>
          !usedRecordIds.has(r.id) &&
          r.fields["Timestamp"]?.startsWith(timestamp.replace("Z", ""))
      );
    }

    if (!match) {
      results.push({ id: exp.id, name: exp.name, found: false, issues: [] });
      continue;
    }

    usedRecordIds.add(match.id);
    const issues = evaluateRecord(match, exp);
    results.push({ id: exp.id, name: exp.name, found: true, issues, airtableId: match.id });
  }

  // Print report
  const exitCode = printReport(results);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
