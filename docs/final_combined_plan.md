# Intelligent Intake System — Final Build Plan

## Problem

Succeed receives inbound enquiries from programme providers, schools, students, and organisations. These messages vary wildly — high-value partnership opportunities sit alongside incomplete requests and outright spam. The team currently triages manually, risking missed opportunities and wasted time.

**This system automates:** interpretation, structuring, scoring, routing, and draft response generation for every inbound enquiry.

**What we are NOT building:** production auth, real-time processing, CRM sync, or a human-approval UI. The output table IS the review surface.

---

## Architecture

```
Inbound Message + Metadata
       |
       v
[1] Set Node
    raw_message, subject, from_email, source, timestamp
       |
       v
[2] Code Node — Extract (OpenAI Structured Outputs + Zod)
    Free text -> schema-guaranteed structured fields + enquiry_category
       |
       v
[3] Validate + Normalize (Code node)
    Spam rules, email check, fee parsing, age normalization, confidence_level
       |
       v
[4] Score (Code node)
    Deterministic category-aware scoring with evidence
       |
       v
[5] Route (Code node)
    Action + review flag + action note
       |
       v
[6] Switch Node
    Branch on action
       |
       +-------------------+-------------------+
       |                   |                   |
       | archive /         | schedule_call /   | (default fallback)
       | manual_review     | request_info /    |
       v                   | share_options     v
  [7a] Airtable            v              [7d] Airtable
  (no AI reply)        [7b] AI Draft Reply (needs_review: true,
                            |               action_note: "Unexpected
                            v               action value — routed
                       [7c] Airtable        to review")
```

### Why this structure

- **Extraction uses OpenAI Structured Outputs with Zod** — the schema is enforced by constrained decoding, guaranteeing valid typed output. No JSON parsing, no missing keys, no hallucinated enum values.
- **Code nodes do validation, scoring, and routing** — these are deterministic logic where consistency and auditability matter.
- **Switch before reply** — spam and failed extractions skip the AI reply node entirely. Saves API calls, prevents drafting replies to garbage.
- **Default fallback on Switch** — if `action` is ever an unexpected value (e.g. a code typo or future enum addition), the enquiry lands in Airtable with `needs_review: true` instead of silently vanishing. Prevents silent data loss.

### Tool stack

- `n8n` — automation layer and demo surface
- `OpenAI API` (GPT-4o) with **Structured Outputs** — extraction (schema-enforced via Zod) and reply drafting
- `Code nodes` (JS) — validation, scoring, routing, and OpenAI SDK calls with Zod schemas
- `Airtable` — source of truth and review surface
- `zod` — schema definitions for structured output enforcement

External dependencies: OpenAI API (extraction + drafting) and Airtable (storage + review surface). All orchestration stays inside n8n.

---

## Data Contract

Every item flowing through the pipeline carries these fields. The validator guarantees they all exist, even if values are `null`.

| Field | Type | Source | Purpose |
|---|---|---|---|
| `raw_message` | string | Set node | Original enquiry text |
| `from_email` | string / null | Set node | Sender email from metadata |
| `source` | string / null | Set node | Channel the message arrived through |
| `timestamp` | string | Set node | ISO datetime |
| `enquiry_category` | enum | Extract | `provider_opportunity`, `school_request`, `student_request`, `organisation_request`, `spam`, `unknown` |
| `sender_type` | enum | Extract | `programme_provider`, `school`, `student`, `organisation`, `unknown` |
| `sender_name` | string / null | Extract | Person or organisation name |
| `programme_name` | string / null | Extract | Named programme if offered, or programme being asked about |
| `programme_topic` | string / null | Extract | Subject area — AI, economics, medicine, coding, etc. (offer or interest) |
| `target_age_range` | string / null | Extract | For providers: age range served. For requesters: age of students they represent. e.g. "16-18" |
| `location` | string / null | Extract | For providers: programme location. For requesters: where they are based or preference. |
| `format` | enum | Extract | `in_person`, `online`, `hybrid`, `unknown` — programme format or delivery preference |
| `fee_text` | string / null | Extract | Original fee string (e.g. "£6,000") — providers only |
| `fee_numeric` | number / null | Validate | Parsed from fee_text |
| `delivery_preference` | string / null | Extract | For requesters: stated preference for in-person, online, abroad, local, etc. Null for providers. |
| `timeline` | string / null | Extract | For requesters: when they need it — "this summer", "next term", etc. Null if not stated. |
| `contact_email` | string / null | Extract+Validate | Validated, may use from_email fallback |
| `intent` | enum | Extract | `partnership`, `listing`, `information_request`, `support_request`, `spam`, `unclear` |
| `summary` | string | Extract | One-sentence summary |
| `missing_fields` | string[] | Extract+Validate | Fields that could not be determined |
| `evidence` | object | Extract | Verbatim snippets supporting extraction |
| `processing_status` | enum | Validate | `ok`, `spam`, `spam_suspected`, `extraction_failed` |
| `confidence_level` | enum | Validate | `high`, `medium`, `low` |
| `validation_flags` | string[] | Validate | Rules that fired |
| `score` | number | Score | 0-100 priority score |
| `tier` | enum | Score | `high`, `medium`, `low`, `minimal`, `spam`, `failed` |
| `factor_scores` | object | Score | Per-factor numeric scores (formatted as readable text in Airtable "Score Breakdown" column) |
| `factor_evidence` | object | Score | Plain-English reasoning per factor (combined into Airtable "Score Rationale" column) |
| `action` | enum | Route | `schedule_call`, `request_info`, `share_options`, `manual_review`, `archive` |
| `action_note` | string / null | Route | Override explanation if any |
| `needs_review` | boolean | Route | Human check needed |
| `reply_questions` | string[] | Route | Customer-facing questions derived from missing_fields (excludes internal fields like sender_name) |
| `reply_draft` | string | Reply | Draft text or "NO_RESPONSE" |

---

## Step 1: INTAKE — Set Node

Capture:
- `raw_message` — the enquiry text
- `from_email` — sender email if available from metadata
- `source` — channel (email, form, webhook, etc.)
- `timestamp` — ISO datetime

This keeps the demo simple and makes it easy to test the five provided examples.

---

## Step 2: EXTRACT — AI-Powered Field Extraction (OpenAI Structured Outputs)

This step uses **OpenAI Structured Outputs** instead of free-form "return JSON" prompting. Structured Outputs use constrained decoding to **guarantee** the response conforms exactly to a schema you define — the model literally cannot produce tokens that violate it. No more parsing failures, no more malformed JSON, no more missing keys.

We define the schema using **Zod** (since our code nodes are JS) and use the OpenAI SDK's `.parse()` helper, which handles schema conversion, the API call, and response parsing in one step.

### Zod Schema Definition

```js
const { z } = require('zod');

const EnquiryCategory = z.enum([
  "provider_opportunity", "school_request", "student_request",
  "organisation_request", "spam", "unknown"
]);

const SenderType = z.enum([
  "programme_provider", "school", "student", "organisation", "unknown"
]);

const Format = z.enum(["in_person", "online", "hybrid", "unknown"]);

const Intent = z.enum([
  "partnership", "listing", "information_request",
  "support_request", "spam", "unclear"
]);

const ExtractionSchema = z.object({
  enquiry_category: EnquiryCategory,
  sender_type: SenderType,
  sender_name: z.string().nullable(),
  programme_name: z.string().nullable(),
  programme_topic: z.string().nullable(),
  target_age_range: z.string().nullable(),
  location: z.string().nullable(),
  format: Format,
  fee_text: z.string().nullable(),
  delivery_preference: z.string().nullable(),
  timeline: z.string().nullable(),
  contact_email: z.string().nullable(),
  intent: Intent,
  summary: z.string(),
  missing_fields: z.array(z.string()),
  evidence: z.record(z.string(), z.string()),
});
```

### Why Zod + Structured Outputs instead of free-form JSON prompting

| | Free-form JSON prompting | Structured Outputs (Zod) |
|---|---|---|
| **Schema conformance** | Best-effort — model may omit fields, use wrong types, or produce invalid JSON | **Guaranteed** — constrained decoding enforces the schema at the token level |
| **Error handling** | Need try/catch for JSON.parse, manual key checking, default fallback objects | Schema violations are impossible; only handle API-level errors (timeout, rate limit) |
| **Enum values** | Model may hallucinate values outside the allowed set | Only declared enum values can appear |
| **Nullable fields** | Model may return `undefined`, empty string, or omit the key entirely | `.nullable()` means the field is always present as either a value or `null` |
| **Type safety** | None — you get `any` from `JSON.parse` | Full TypeScript inference from the Zod schema — `result.enquiry_category` is typed as the enum |
| **Prompt overhead** | ~30 lines of "Return ONLY valid JSON with these fields..." instructions | Schema is defined in code; prompt focuses purely on extraction logic |

### Extraction API Call (Code Node)

This replaces the n8n AI node with a Code node that calls the OpenAI API directly using structured outputs.

```js
const OpenAI = require('openai');
const { zodResponseFormat } = require('openai/helpers/zod');

const client = new OpenAI({ apiKey: $env.OPENAI_API_KEY });

const rawMessage = $json.raw_message;
const fromEmail = $json.from_email;
const source = $json.source;

const systemPrompt = `You are an intake classifier for Succeed, an education platform that connects students with enrichment programmes, summer schools, and academic experiences. The platform primarily serves high-school and early-university students.

Analyse the following inbound enquiry and extract structured data into the provided schema.

Rules:
- If a field cannot be determined from the message, use null and add the field name to missing_fields
- enquiry_category should reflect who is writing and what they want: providers offering programmes = provider_opportunity, schools looking for options = school_request, students asking about opportunities = student_request
- Fields like programme_topic, target_age_range, location, and format are bidirectional: for providers they describe the offering; for schools/students they describe the need or interest. Extract whichever applies.
- delivery_preference and timeline are requester-only fields — set to null for provider_opportunity
- fee_text is provider-only — set to null for school_request and student_request
- Mark enquiry_category as "spam" if the message is promotional, contains suspicious links, or is clearly unrelated to education
- For evidence, quote directly from the message — do not paraphrase`;

let userContent = `Message: ${rawMessage}`;
if (fromEmail) userContent += `\nSender email: ${fromEmail}`;
if (source) userContent += `\nSource: ${source}`;

const completion = await client.beta.chat.completions.parse({
  model: "gpt-4o",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ],
  response_format: zodResponseFormat(ExtractionSchema, "enquiry_extraction"),
});

const message = completion.choices[0].message;

// Handle refusals (safety filters)
if (message.refusal) {
  return [{ json: { ...defaultFailureObject, refusal: message.refusal } }];
}

// message.parsed is a fully-typed object matching ExtractionSchema
const extracted = message.parsed;
return [{ json: { ...$json, ...extracted } }];
```

### Why this approach

- **No "Return ONLY valid JSON" instructions needed** — the schema is enforced by constrained decoding, so the prompt focuses entirely on extraction logic and domain rules
- **No JSON.parse try/catch** — the SDK's `.parse()` method returns a typed object directly. The only failure mode is an API-level error (timeout, rate limit, refusal), not a malformed response
- **Enums are enforced** — `enquiry_category` can only be one of the 6 declared values. The model cannot hallucinate "provider" or "school_enquiry" — only the exact enum values defined in Zod
- **Nullable fields are always present** — `.nullable()` means the key always exists in the output as either a value or `null`. No need to check for `undefined` or missing keys
- **First-request latency** — OpenAI compiles and caches the schema's constrained decoding automaton on the first call. Subsequent calls with the same schema are fast. Use a consistent schema name (`"enquiry_extraction"`) to benefit from caching
- **evidence field** — `z.record(z.string(), z.string())` enforces that evidence is always an object with string keys and string values, never an array or nested structure
- `missing_fields` — `z.array(z.string())` guarantees it's always an array, never null or a comma-separated string

### Extraction Prompt (simplified — schema handles structure)

The prompt no longer needs to list every field and its type. With structured outputs, the schema defines the structure and the prompt focuses on **what to extract and how**:

```
You are an intake classifier for Succeed, an education platform that connects students
with enrichment programmes, summer schools, and academic experiences.
The platform primarily serves high-school and early-university students.

Analyse the following inbound enquiry and extract structured data into the provided schema.

Message: {{ $json.raw_message }}
{% if $json.from_email %}Sender email: {{ $json.from_email }}{% endif %}
{% if $json.source %}Source: {{ $json.source }}{% endif %}

Rules:
- If a field cannot be determined from the message, use null and add it to missing_fields
- enquiry_category should reflect who is writing and what they want: providers offering programmes = provider_opportunity, schools looking for options = school_request, students asking about opportunities = student_request
- Fields like programme_topic, target_age_range, location, and format are bidirectional: for providers they describe the offering; for schools/students they describe the need or interest. Extract whichever applies.
- delivery_preference and timeline are requester-only fields — set to null for provider_opportunity
- fee_text is provider-only — set to null for school_request and student_request
- Mark enquiry_category as "spam" if the message is promotional, contains suspicious links, or is clearly unrelated to education
- For evidence, quote directly from the message — do not paraphrase
```

### Why this prompt structure

- **~15 fewer lines than the original** — all field definitions, types, and enum values are now enforced by the Zod schema. The prompt only carries extraction rules and domain context
- Succeed-specific context ("education platform for high-school and early-university students") gives the AI domain grounding without hardcoding a specific age range that isn't confirmed by the brief
- `enquiry_category` is the key discriminator — it drives category-aware scoring and routing downstream
- `missing_fields` + `evidence` make the output table useful for human reviewers and make follow-ups targeted
- `fee_text` naming avoids confusion with the numeric version added later
- Evidence requires verbatim quotes, not paraphrasing — keeps extraction auditable

---

## Step 3: VALIDATE — Deterministic Checks + Normalization

Code node. Runs BEFORE scoring.

### What it does

1. **Extraction failure check** — because the Extract code node uses OpenAI Structured Outputs, **malformed JSON and missing keys are no longer possible failure modes**. The only failures are API-level: timeout, rate limit, network error, or model refusal. The Extract code node wraps the API call in try/catch and passes either the parsed result or a failure object downstream:

   ```js
   // Inside the Extract code node (try/catch wraps the API call):
   try {
     const completion = await client.beta.chat.completions.parse({ /* ... */ });
     const message = completion.choices[0].message;

     if (message.refusal) {
       return [{ json: { ...$json, _extractionFailed: true, _failureReason: message.refusal } }];
     }

     return [{ json: { ...$json, ...message.parsed } }];
   } catch (e) {
     return [{ json: { ...$json, _extractionFailed: true, _failureReason: e.message } }];
   }
   ```

   The Validate code node then checks for the failure flag at the top:

   ```js
   const input = $input.first().json;

   if (input._extractionFailed) {
     return [{
       json: {
         ...input,
         enquiry_category: "unknown",
         sender_type: "unknown",
         summary: "Extraction failed — raw message preserved for manual review",
         missing_fields: ["all"],
         processing_status: "extraction_failed",
         confidence_level: "low",
         sender_name: null, programme_name: null, programme_topic: null,
         target_age_range: null, location: null, format: "unknown",
         fee_text: null, fee_numeric: null, contact_email: null,
         intent: "unclear", evidence: {}, validation_flags: ["extraction_failed"]
       }
     }];
   }
   ```

   With structured outputs, this covers two failure modes: (a) API error (timeout, rate limit, network), (b) model refusal (safety filters). The old failure modes — malformed JSON and missing keys — are eliminated by constrained decoding.

2. **Enum validation** — defensive check against allowed values. Structured Outputs should enforce enums, but if the model or SDK version drifts (or a future refactor bypasses Zod), an unexpected value like `"provider"` instead of `"provider_opportunity"` would pass JSON parsing but break downstream routing and scoring. This 10-line guard catches it:

   ```js
   const ALLOWED = {
     enquiry_category: ["provider_opportunity", "school_request", "student_request", "organisation_request", "spam", "unknown"],
     sender_type: ["programme_provider", "school", "student", "organisation", "unknown"],
     format: ["in_person", "online", "hybrid", "unknown"],
     intent: ["partnership", "listing", "information_request", "support_request", "spam", "unclear"],
   };

   for (const [field, allowed] of Object.entries(ALLOWED)) {
     if (input[field] && !allowed.includes(input[field])) {
       input.validation_flags.push(`invalid_enum_${field}: "${input[field]}"`);
       input[field] = "unknown";
     }
   }
   ```

   Any invalid enum value is replaced with `"unknown"` and flagged in `validation_flags`, so the item flows through scoring and routing safely rather than crashing or misrouting.

3. **Deterministic spam override** — regex patterns catch obvious spam even if the AI missed it:
   - Phrases: "grow your LinkedIn", "check out our tool", "SEO services", "lead generation", "crypto", "forex", "click here", "make money", "$5000/day"
   - Suspicious TLDs/links: `.xyz`, `.tk`, link-shorteners (`bit.ly`, `tinyurl`)
   - Obviously irrelevant commercial outreach

   **Spam signal counting:** Each matching rule increments a `spam_signal_count`. Record all fired rules in `validation_flags`.
   - If `spam_signal_count >= 2`: hard spam — set `enquiry_category = "spam"`, `processing_status = "spam"`, action will be `archive`.
   - If `spam_signal_count === 1`: suspected spam — set `processing_status = "spam_suspected"`, action will be `manual_review`. This prevents false positives where a legitimate enquiry happens to contain a single suspicious pattern (e.g. a `.xyz` domain that is actually a real programme site).

3. **Email validation** — if `contact_email` doesn't match a basic email regex, clear it and add `"contact_email"` to `missing_fields`.

4. **Contact email fallback** — if `contact_email` is null but `from_email` metadata exists and passes validation, use `from_email`.

5. **Fee normalization** — parse `fee_text` string into `fee_numeric` (e.g., "£6,000" -> 6000, "$2,500" -> 2500).

6. **Age range normalization** — standardize formats like "16 to 18" -> "16-18", "ages 14-21" -> "14-21".

7. **Confidence level** — derived from extraction quality:
   - `high`: schema-valid, <= 2 missing fields, no validation overrides
   - `medium`: 3-4 missing fields but coherent extraction
   - `low`: 5+ missing fields, schema repair needed, or spam override applied

8. **Processing status** — if not already set:
   - `"spam"` if 2+ spam signals fired
   - `"spam_suspected"` if exactly 1 spam signal fired
   - `"extraction_failed"` if extraction was unusable
   - `"ok"` otherwise

### Fields added by validation

| Field | Type | Purpose |
|---|---|---|
| `processing_status` | enum | `ok`, `spam`, `spam_suspected`, `extraction_failed` |
| `fee_numeric` | number / null | Parsed from fee_text |
| `confidence_level` | enum | `high`, `medium`, `low` |
| `validation_flags` | string[] | Rules that fired |

---

## Step 4: SCORE — Deterministic Category-Aware Scoring

The score means **priority to act**, not just expected revenue. A genuine school request with a clear need should score higher than an ambiguous organisation enquiry, even though the school isn't a direct revenue lead.

### Gate Checks (before scoring)

- If `processing_status === "extraction_failed"` -> score 0, tier "failed", action "manual_review", skip all factors
- If `processing_status === "spam"` -> score 0, tier "spam", action "archive", skip all factors
- If `processing_status === "spam_suspected"` -> score 0, tier "spam", action "manual_review", skip all factors

### Scoring Factors (5 factors, 100 total)

| Factor | Max | What it measures |
|---|---:|---|
| `fit_to_succeed` | 25 | How well this enquiry matches Succeed's platform and audience |
| `value_and_actionability` | 25 | Commercial value (providers) or service value (schools/students) |
| `completeness` | 20 | How much usable detail is present |
| `contactability` | 10 | Can we actually follow up with this person |
| `strategic_signal` | 20 | Prestige, fee level, international reach, specific need |

**Total: 0-100**

### Why 5 factors instead of 4

Splitting completeness from contactability prevents a lead with full programme details but no email from scoring the same as a bare-bones message that happens to include an email. They need different follow-up actions.

---

### Fit to Succeed (25 pts) — category-aware

**For `provider_opportunity`:**
- `programme_provider` + age range targeting high-school or early-university students -> 25
- `programme_provider` without age range -> 20
- `organisation` with education-adjacent topic -> 15
- `organisation` without clear education link -> 10

**For `school_request`:**
- `school` + relevant subject area (medicine, STEM, arts, etc.) -> 22
- `school` without subject specificity -> 18

**For `student_request`:**
- `student` + specific interest area -> 18
- `student` without specifics -> 12

**For `unknown` / `organisation_request`:**
- -> 8

**Evidence example:** `"Programme provider targeting 16-18 — direct Succeed audience fit"`

---

### Value and Actionability (25 pts) — category-aware

**For `provider_opportunity`:**
- `partnership` intent + fee present -> 25
- `partnership` intent, no fee -> 18
- `listing` intent + fee -> 15
- `listing` intent, no fee -> 10
- `unclear` intent -> 5

**For `school_request` / `student_request`:**
- Specific subject + clear need stated -> 18
- Specific subject, vague need -> 12
- No subject specificity -> 6

**For `organisation_request` / `unknown`:**
- `partnership` intent -> 10
- `unclear` intent -> 3

**Evidence example:** `"Intent: partnership, fee: £6,000 — strong commercial signal"`

---

### Completeness (20 pts)

How much usable structured data was extracted, regardless of category.

- 6+ fields populated with real values -> 20
- 4-5 fields populated -> 14
- 2-3 fields populated -> 8
- 0-1 fields populated -> 3

Key fields to count (category-aware):
- **Providers:** `sender_name`, `programme_name`, `programme_topic`, `target_age_range`, `location`, `format`, `fee_text`, `contact_email` (8 fields)
- **Schools/students:** `sender_name`, `programme_topic`, `target_age_range`, `location`, `delivery_preference`, `timeline`, `contact_email` (7 fields)
- **Other:** count all non-null fields from the union of both sets (9 fields max)

**Evidence example:** `"6 of 8 provider key fields populated — strong data completeness"` or `"3 of 7 requester key fields populated"`

---

### Contactability (10 pts)

Can we actually reach this person?

- Valid `contact_email` present -> 10
- Email from `from_email` fallback only -> 6
- No usable email -> 0

**Evidence example:** `"Direct contact email: dean@oxford-econ.edu"`

---

### Strategic Signal (20 pts) — additive, capped at 20

- Fee numeric >= 3000 -> +5
- International location or "global"/"international"/"worldwide" language -> +5
- Specific cohort detail (named programme, exact age range, subject area) -> +4
- Well-known institution (Oxford, Cambridge, Imperial, Harvard, MIT, Stanford, etc.) -> +4
- "Selective"/"competitive"/"limited places" language -> +3
- Multiple countries or "50+ countries" type language -> +3

**Evidence example:** `"Fee £6,000 (+5); global reach language (+5); Oxford (+4); selective (+3)"`

### Why strategic signal is capped at 20, not 25

The previous plan gave prestigious institution names +15 out of 25 points. That meant "Oxford" alone could swing a score by 15%, which overweights brand recognition relative to actual fit and actionability. This version caps prestige at +4 and distributes weight across fee, reach, specificity, and selectivity — signals that actually correlate with partnership quality.

---

### Tier Assignment

| Tier | Score Range |
|---|---|
| high | >= 75 |
| medium | 45-74 |
| low | 20-44 |
| minimal | 1-19 |
| spam | 0 (spam gate) |
| failed | 0 (extraction failed gate) |

### Output Per Factor

For every factor, store:
- the numeric sub-score
- a short plain-English explanation
- a cited evidence snippet where possible

This directly satisfies the task brief's requirement to show "the factors or logic behind the score."

---

## Step 5: ROUTE — Action Assignment

### Action Set

`action` is the **recommended next step** — what should happen once a human approves (if review is required). `needs_review` is the gate: when `true`, the action is a recommendation awaiting approval, not an auto-executed instruction. Draft replies are generated for `schedule_call`, `request_info`, and `share_options` only. `manual_review` and `archive` never get a draft — the human triages from raw data.

| Action | What it means | Immediate step |
|---|---|---|
| `schedule_call` | Propose a 15-minute introductory call | If `needs_review`: human reviews draft then sends. Otherwise: draft ready to send. |
| `request_info` | Ask for specific missing details | Draft ready; send when reviewed if flagged. |
| `share_options` | Acknowledge need, explain what Succeed offers | Draft ready; send when reviewed if flagged. |
| `manual_review` | Human decides next step | No draft generated — human triages from raw data. |
| `archive` | No action, spam or irrelevant | Row stored; no follow-up. |

### Routing Rules (deterministic matrix)

Rules are evaluated top-to-bottom; first match wins.

| # | `processing_status` | `enquiry_category` | `tier` | `contact_email` | Action |
|---|---|---|---|---|---|
| 1 | `extraction_failed` | any | any | any | `manual_review` |
| 2 | `spam` | any | any | any | `archive` |
| 3 | `spam_suspected` | any | any | any | `manual_review` |
| 4 | `ok` | `provider_opportunity` | high/medium | not null | `schedule_call` |
| 5 | `ok` | `provider_opportunity` | high/medium | null | `request_info` |
| 6 | `ok` | `provider_opportunity` | low/minimal | any | `request_info` |
| 7 | `ok` | `school_request` / `student_request` | high/medium | not null | `share_options` |
| 8 | `ok` | `school_request` / `student_request` | high/medium | null | `manual_review` |
| 9 | `ok` | `school_request` / `student_request` | low | not null | `request_info` |
| 10 | `ok` | `school_request` / `student_request` | low/minimal | null | `manual_review` |
| 11 | `ok` | `organisation_request` / `unknown` | any | any | `manual_review` |

### Reply Questions Generation

The routing node generates `reply_questions` — a customer-facing version of `missing_fields` that excludes internal/system fields and rephrases technical field names into natural questions. This prevents the reply prompt from asking senders for things like "sender_name" or "contact_email" in raw form.

**Field mapping (category-aware):**

For **provider_opportunity**:

| Internal field | Customer-facing question |
|---|---|
| `fee_text` | "Could you share your programme's fee structure?" |
| `target_age_range` | "What age range is your programme designed for?" |
| `programme_name` | "What is the name of your programme?" |
| `programme_topic` | "What subject area does your programme focus on?" |
| `location` | "Where is your programme based?" |
| `format` | "Is your programme in-person, online, or hybrid?" |

For **school_request** / **student_request**:

| Internal field | Customer-facing question |
|---|---|
| `target_age_range` | "What age range are your students?" |
| `programme_topic` | "What subject areas are you most interested in?" |
| `location` | "Where are you based?" |
| `delivery_preference` | "Do you have a preference for in-person, online, or overseas programmes?" |
| `timeline` | "When are you looking for programmes — this summer, next term, or another timeframe?" |

**Excluded from reply_questions** (internal/system fields): `sender_name`, `contact_email`, `from_email`. If contact email is missing, the router adds a generic "What is the best email to reach you?" question instead.

### Overrides

1. **No-contact override:** If `contact_email` is null and `from_email` is also null, downgrade any outbound action (`schedule_call`, `request_info`, `share_options`) to `manual_review`. Record in `action_note`: "Downgraded to manual_review: no contact channel available." The system cannot send a follow-up to someone it cannot reach — a human must find the contact path.

2. **Contact-email override:** If action would be `schedule_call` but `contact_email` is null (though `from_email` exists as fallback), downgrade to `request_info`. Record in `action_note`: "Downgraded from schedule_call: no direct contact email."

3. **High-value review flag:** If `score >= 75`, set `needs_review = true`. High-value items deserve a human check before any outbound action.

4. **Low-confidence review flag:** If `confidence_level === "low"`, set `needs_review = true`.

5. **Extraction failure:** If `processing_status === "extraction_failed"`, set `needs_review = true`.

---

## Step 6: RESPOND — AI-Generated Follow-Up

Only runs for `schedule_call`, `request_info`, and `share_options`. Spam, archive, and manual_review skip this node entirely (handled by the Switch node).

**Continue On Fail:** Enable "Continue On Fail" on the Reply node (same as on the Extract node). If the OpenAI call for reply drafting errors (timeout, rate limit, content filter), the item still flows to the Airtable write with `reply_draft: "DRAFT_FAILED"` instead of crashing the pipeline or writing a row with no draft field. The Airtable row stays intact and a human can draft the reply manually.

```js
// Wrap the reply API call:
try {
  const reply = await client.chat.completions.create({ /* ... */ });
  return [{ json: { ...$json, reply_draft: reply.choices[0].message.content } }];
} catch (e) {
  return [{ json: { ...$json, reply_draft: "DRAFT_FAILED", draft_error: e.message } }];
}
```

### Reply Prompt

```
You are writing a follow-up email on behalf of Succeed, an education platform that
connects high-school and early-university students with enrichment programmes and academic experiences.

Enquiry context:
- Sender: {{ $json.sender_name || "Unknown sender" }}
- Type: {{ $json.sender_type }}
- Category: {{ $json.enquiry_category }}
- Programme: {{ $json.programme_name || "Not specified" }}
- Topic: {{ $json.programme_topic || "Not specified" }}
- Summary: {{ $json.summary }}
- Priority: {{ $json.tier }} (score: {{ $json.score }}/100)
- Action: {{ $json.action }}
- Questions to ask: {{ $json.reply_questions?.join("; ") || "None" }}

Rules by action:
- schedule_call: Be warm and specific. Reference their programme by name. Propose a 15-minute introductory call this week. Mention Succeed's student audience.
- request_info: Acknowledge their interest. Ask the specific questions listed in "Questions to ask" above, rephrased naturally into your email. Do NOT use internal field names. Keep it inviting, not transactional.
- share_options: Acknowledge their need. Briefly explain how Succeed can help. Invite them to explore relevant options or suggest a next step.

Constraints:
- Under 80 words for schedule_call and share_options; under 120 words for request_info (needs room for multiple questions)
- For request_info: ask only the top 3 most important questions from the list. If more are needed, note "we may follow up with a few more questions" rather than cramming them all in.
- Professional but approachable tone
- Sign off as "The Succeed Team"
- No exclamation marks. No "excited to hear from you." No filler.
- Reference specific details from the enquiry to show this is not a template.
```

---

## Step 7: STORE — Airtable Output Table

### Table Schema

| Column | Source | Notes |
|---|---|---|
| Raw Input | Set node | Original message text |
| Enquiry Category | Step 2 | provider_opportunity / school_request / etc. |
| Sender Type | Step 2 | Enum |
| Sender Name | Step 2 | |
| Programme Name | Step 2 | |
| Programme Topic | Step 2 | |
| Age Range | Step 2 | |
| Location | Step 2 | |
| Format | Step 2 | in_person / online / hybrid / unknown |
| Fee Text | Step 2 | Original string |
| Fee Numeric | Step 3 | Parsed number |
| Delivery Preference | Step 2 | Requester-side: in-person, online, abroad, etc. |
| Timeline | Step 2 | Requester-side: when they need it |
| Contact Email | Step 2+3 | Validated, may use from_email fallback |
| Intent | Step 2 | Enum |
| Summary | Step 2 | One sentence |
| Missing Fields | Step 2 | Comma-separated |
| Processing Status | Step 3 | ok / spam / spam_suspected / extraction_failed |
| Confidence Level | Step 3 | high / medium / low |
| Validation Flags | Step 3 | Any rule overrides applied |
| Priority Score | Step 4 | 0-100 |
| Priority Tier | Step 4 | high / medium / low / minimal / spam / failed |
| Score Breakdown | Step 4 | Readable text: "Fit: 20/25, Value: 25/25, Completeness: 14/20, Contact: 10/10, Strategic: 20/20" |
| Score Rationale | Step 4 | One-line summary + per-factor evidence (e.g. "Strong provider fit + fee + Oxford. Fit: Provider, no age range. Value: Partnership + fee £6,000. ...") |
| Reply Questions | Step 5 | Customer-facing questions for follow-up (comma-separated) |
| Next Action | Step 5 | schedule_call / request_info / share_options / manual_review / archive |
| Action Note | Step 5 | Override explanation if any |
| Needs Review | Step 5 | Boolean |
| Draft Follow-Up | Step 6 | Full text or "NO_RESPONSE" |
| Timestamp | Auto | ISO datetime |

### Airtable Views

**Essential (create first):**

| View | Filter | Purpose |
|---|---|---|
| All Enquiries | None | Default, sorted by timestamp |
| High Priority | Tier = "high" | Partnership opportunities to act on |
| Needs Review | needs_review = true | Failed extractions + edge cases + high-value |

**Deferred (add during polish if time allows):**

| View | Filter | Purpose |
|---|---|---|
| Needs Info | Action = "request_info" | Leads that need follow-up questions |
| School / Student | Category in (school_request, student_request) | Non-provider enquiries |
| Spam / Archived | Processing Status in ("spam", "spam_suspected") | Audit trail |

---

## Expected Outputs for the 5 Test Inputs

### Example 1 — Barcelona AI Programme

| Field | Value |
|---|---|
| enquiry_category | provider_opportunity |
| sender_type | programme_provider |
| programme_topic | AI |
| target_age_range | 16-18 |
| location | Barcelona |
| fee_text | null |
| contact_email | null |
| missing_fields | ["fee_text", "contact_email", "sender_name"] |
| reply_questions | ["Could you share your programme's fee structure?", "What is the best email to reach you?"] |
| processing_status | ok |
| confidence_level | medium |
| **Score** | **66** |
| factor_scores | fit: 25, value: 18, completeness: 14, contactability: 0, strategic: 9 |
| factor_evidence | "Provider targeting 16-18 — direct fit"; "Partnership intent, no fee"; "4 of 8 key fields (topic, age, location, format)"; "No email"; "International: Barcelona (+5), specific cohort (+4)" |
| **Tier** | **medium** |
| **Action** | **manual_review** |
| action_note | Downgraded to manual_review: no contact channel available |
| needs_review | true |
| Draft | NO_RESPONSE |

**Why manual_review despite medium score:** Strong audience fit (25) and clear partnership intent (18), but no contact email and no from_email — the system has no way to send a follow-up. A human must find the contact path before any outbound action.

### Example 2 — School Counsellor / Medicine

| Field | Value |
|---|---|
| enquiry_category | school_request |
| sender_type | school |
| programme_topic | medicine |
| delivery_preference | null |
| timeline | null |
| missing_fields | ["target_age_range", "location", "delivery_preference", "timeline", "contact_email", "sender_name"] |
| reply_questions | ["What age range are your students?", "Where are you based?", "Do you have a preference for in-person, online, or overseas programmes?", "When are you looking for programmes?", "What is the best email to reach you?"] |
| processing_status | ok |
| confidence_level | low |
| **Score** | **41** |
| factor_scores | fit: 22, value: 12, completeness: 3, contactability: 0, strategic: 4 |
| factor_evidence | "School with relevant subject (medicine)"; "Specific subject, vague need"; "1 of 7 key fields (topic only)"; "No email"; "Subject specificity: medicine (+4)" |
| **Tier** | **low** |
| **Action** | **manual_review** |
| action_note | Downgraded to manual_review: no contact channel available |
| needs_review | true (low confidence + no contact) |
| Draft | NO_RESPONSE |

**Why manual_review despite being actionable:** Score 41 correctly reflects how little structured data this message contains — only 1 of 7 key fields populated, no email, no programme details. Category-aware scoring means the fit (22) and value (12) factors still recognise this as a genuine school enquiry worth pursuing. Without category awareness, an organisation with the same data sparsity would score 15. However, with no contact email and no from_email, the system cannot send a follow-up — a human must find the contact path first.

### Example 3 — LinkedIn Spam

| Field | Value |
|---|---|
| enquiry_category | spam |
| processing_status | spam |
| validation_flags | ["spam_override_by_rules"] |
| **Score** | **0** |
| **Tier** | **spam** |
| **Action** | **archive** |
| Draft | NO_RESPONSE |

Caught by both the AI and deterministic regex rules (suspicious link, "grow your LinkedIn").

### Example 4 — Oxford Economics / £6,000

| Field | Value |
|---|---|
| enquiry_category | provider_opportunity |
| sender_type | programme_provider |
| programme_topic | economics |
| fee_text | £6,000 |
| fee_numeric | 6000 |
| contact_email | dean@oxford-econ.edu |
| processing_status | ok |
| confidence_level | high |
| **Score** | **89** |
| factor_scores | fit: 20, value: 25, completeness: 14, contactability: 10, strategic: 20 |
| factor_evidence | "Provider, age range not stated"; "Partnership + fee £6,000"; "5 of 8 key fields (topic, location, fee, email, programme name)"; "Direct email: dean@oxford-econ.edu"; "Fee >= £3k (+5), global reach (+5), Oxford (+4), selective (+3), economics cohort (+4) = 21, capped at 20" |
| **Tier** | **high** |
| **Action** | **schedule_call** |
| **needs_review** | **true** (score >= 75) |
| Draft | "Hi Dean, thank you for reaching out about the Oxford economics programme. The selective format and global reach sound like a strong fit for our student audience. Would you be available for a 15-minute introductory call this week to discuss how Succeed could help with international applications? — The Succeed Team" |

**Why needs_review despite schedule_call:** High-value items get a human check before any outbound action. Drafts are fine; auto-send is not.

### Example 5 — Online Coding Bootcamp

| Field | Value |
|---|---|
| enquiry_category | organisation_request |
| sender_type | organisation |
| intent | partnership |
| format | online |
| missing_fields | ["programme_name", "target_age_range", "location", "fee_text", "contact_email", "sender_name"] |
| processing_status | ok |
| confidence_level | low |
| **Score** | **26** |
| factor_scores | fit: 8, value: 10, completeness: 8, contactability: 0, strategic: 0 |
| factor_evidence | "Organisation, unclear audience fit"; "Partnership intent stated, but organisation type"; "2 of 9 key fields (topic, format)"; "No email"; "No strategic signals" |
| **Tier** | **low** |
| **Action** | **manual_review** |
| needs_review | true (low confidence) |
| Draft | NO_RESPONSE |

**Why manual_review:** Not spam, but too ambiguous to route confidently. Low confidence + unclear intent = let a human decide.

---

## Eval Pack — 5 Adversarial Cases

| # | Input | Tests |
|---|---|---|
| 6 | Empty string `""` | Extraction failure -> manual_review row, not a crash |
| 7 | `"URGENT!!! Make $5000/day from home click here bit.ly/scam123"` | Deterministic spam rules catch this even if AI is unsure |
| 8 | `"Hi, I'm a parent. My daughter is 15 and interested in summer programmes abroad. Can you help?"` | student_request, genuine, low score but has from_email -> `share_options`. Expected draft: "Thank you for getting in touch. Succeed connects students with enrichment programmes and summer schools, including options abroad. We have several programmes that could suit a 15-year-old — we'd be happy to share some relevant options. — The Succeed Team" |
| 9 | `"We run the Global STEM Challenge for 14-18 year olds. 50+ countries. Fee $2,500. Contact: partnerships@globalstem.org"` | Should score very high: audience fit + fee + email + international + STEM -> `schedule_call`. Expected draft: "Thank you for reaching out about the Global STEM Challenge. A programme serving 14-18 year olds across 50+ countries is a strong fit for Succeed's student audience. Would you be available for a 15-minute call this week to discuss a potential partnership? — The Succeed Team" |
| 10 | `"ksjdhfkjsdhf random noise 12345 @@@"` | Extraction failure or minimal -> failure row, no crash |

---

## n8n Workflow Structure

```
[Manual Trigger / Webhook]
    |
    v
[Set Node] — Attach raw_message + metadata (from_email, source, timestamp)
    |
    v
[Code Node — Extract] — OpenAI Structured Outputs (GPT-4o + Zod schema)
    |  (Constrained decoding guarantees schema conformance; try/catch
    |   handles API errors and produces a default failure object)
    v
[Code Node — Validate] — Spam signal counting, email check, fee parse, age normalization, confidence
    |
    v
[Code Node — Score] — Deterministic category-aware scoring with evidence
    |
    v
[Code Node — Route] — Action assignment + overrides + needs_review
    |
    v
[Switch Node] — Branch on action
    +-- archive -----------> [Airtable: Write Row] (no AI reply)
    +-- manual_review -----> [Airtable: Write Row] (no AI reply)
    +-- schedule_call -----> [AI Node — Reply] -> [Airtable: Write Row]
    +-- request_info ------> [AI Node — Reply] -> [Airtable: Write Row]
    +-- share_options -----> [AI Node — Reply] -> [Airtable: Write Row]
    +-- (default) ---------> [Airtable: Write Row] (needs_review: true, action_note: "Unexpected action value")
```

---

## Build Order (90 minutes)

| Phase | Time | What | Test with |
|---|---:|---|---|
| 1. Airtable setup | 10 min | Create base with all columns + 3 essential views (All, High Priority, Needs Review). Defer other views to polish. | — |
| 2. n8n skeleton | 10 min | Trigger -> Set -> placeholder nodes -> Airtable write test | Any input |
| 3. Extract node | 15 min | Code node: define Zod schema, wire OpenAI SDK `.parse()` call with extraction prompt | Example 4 (most complete) |
| 4. Validate node | 15 min | Spam rules, email validation, fee parsing, age normalization, confidence | Example 3 (spam) |
| 5. Score node | 10 min | Category-aware scoring with evidence strings | Examples 2, 4 |
| 6. Route node | 5 min | Deterministic rule matrix + overrides + needs_review | Examples 1, 4 |
| 7. Reply node | 10 min | Wire AI reply prompt, verify manual_review gets NO_RESPONSE | Examples 4, eval case 9 |
| 8. End-to-end test | 10 min | Run all 5 examples, verify Airtable rows | All 5 |
| 9. Polish | 5 min | Add remaining views, run 1 adversarial input | Case 6 or 7 |

---

## Submission Pack

Prepare these as part of the build, not at the end:

- Screenshot or share link of the n8n workflow
- Screenshot of Airtable with at least the 5 sample inputs processed
- Validation, scoring, and routing logic from code nodes
- The extraction prompt and reply prompt
- The prompt(s) used to help generate or refine the custom logic
- 1-2 sentences on how AI helped generate or refine the custom logic
- Loom video (5-10 min)

---

## Loom Talking Points

1. **System overview** — Show the n8n workflow, explain the pipeline. Point out where AI is used (extraction + drafting) vs where logic is deterministic (validation + scoring + routing).

2. **High-value walkthrough** — Run Example 4 (Oxford) end-to-end. Show the Airtable row with score breakdown, factor evidence, and the draft reply. Point out `needs_review = true`.

3. **Problem input** — Run Example 3 (spam). Show it's caught by both AI and deterministic rules. Show NO_RESPONSE and validation_flags in Airtable.

4. **Follow-up vs. no-contact** — Show Example 1 or 2 (both `manual_review` / `NO_RESPONSE` because no contact email exists). Explain the no-contact override: the system recognises the enquiry is valuable but won't draft a reply it can't deliver. Then show Example 4's draft as the contrast — a concrete, specific follow-up that references the programme by name.

5. **Tradeoff 1 — deterministic scoring + structured outputs:**
   "I used AI for extraction and drafting, but I kept validation, scoring, and routing deterministic. For extraction, I used OpenAI Structured Outputs with a Zod schema — the model's output is guaranteed to conform to my schema via constrained decoding, so I never get malformed JSON or hallucinated field values. That gave me the speed benefits of AI without turning the core decision logic into a black box. If Oxford comes through the system 100 times, it scores 89 every time. An LLM might give it 82 one run and 94 the next. For a task that evaluates judgment and structure, I wanted the scoring to be auditable."

6. **Tradeoff 2 — category-aware scoring (if time):**
   "I added enquiry_category to distinguish providers from schools and students. The brief explicitly mentions all three. Without this, a school counsellor looking for medicine enrichment scores 15 and gets archived. With category-aware scoring, it scores 41 — the system recognises it's a genuine school enquiry worth pursuing, even though it can't send a follow-up yet because there's no contact email. That felt like the right call for a platform that serves both sides."

---

## Design Decisions Log

### Taken from Claude Combined Plan
- Complete, implementation-ready prompts (extraction + reply)
- Clear architecture diagram and n8n workflow structure
- Concrete scoring rubric with specific point values per category
- Switch node before reply (spam skips drafting)
- Contact-email routing override
- Eval pack with adversarial test cases
- Build order with realistic time budget
- Loom tradeoff framing
- Detailed expected outputs for all 5 examples

### Taken from Codex Combined Plan
- 5 scoring factors separating completeness (20) from contactability (10)
- `fee_text` / `fee_numeric` naming (clearer than `fee` / `fee_numeric`)
- `processing_status` field (cleaner than scattered booleans)
- Reduced prestige keyword weight (+4 instead of +15)
- Age range normalization in validation
- More pragmatic confidence_level descriptions
- Flexible score ranges in expected outputs

### Changed in this plan
- **Extraction uses OpenAI Structured Outputs with Zod** instead of free-form "Return ONLY valid JSON" prompting — constrained decoding guarantees schema conformance, eliminates JSON parsing failures, enforces enum values, and ensures nullable fields are always present. The extraction prompt is ~15 lines shorter because field definitions and types live in the Zod schema, not the prompt
- Extract step is now a Code node (not an n8n AI node) that calls the OpenAI SDK directly via `client.beta.chat.completions.parse()` with `zodResponseFormat()` — this gives full control over structured output configuration and error handling
- Validation no longer needs JSON.parse try/catch or missing-key checks — the only failure modes are API errors (timeout, rate limit) and model refusals, both handled via try/catch in the Extract code node
- Strategic signal capped at 20 (not 25) — prestige is +4 (not +15), preventing brand names from dominating scores
- Completeness scored by counting populated fields (objective) rather than using the AI's own completeness enum (subjective)
- Removed the `completeness` enum from extraction output — the validator counts fields instead, which is more reliable
- Airtable has 30 columns — trimmed by consolidating 5 score sub-columns + factor evidence + rationale into 2 readable text fields (Score Breakdown + Score Rationale)
- Validation time budget increased from 10 to 15 min (age normalization + more robust spam patterns)
- Polish phase reduced from 10 to 5 min to compensate
- Added explicit extraction failure branch with try/catch and default failure object — guarantees every run writes a row even on AI failure
- Replaced raw `missing_fields` in reply prompt with curated `reply_questions` — prevents internal field names from appearing in customer-facing emails
- Removed hardcoded "14-21" age assumption — replaced with "high-school and early-university students" since the task brief does not define a specific age range
- Softened spam detection: single-signal matches now route to `manual_review` as `spam_suspected` instead of hard-archiving — reduces false positive risk
- Flattened factor scores into 5 individual Airtable columns + one-line Score Rationale field — makes the output table immediately legible without parsing JSON
- Made schema bidirectional: shared fields (topic, age range, location, format) now serve both offer-side and request-side enquiries. Added `delivery_preference` and `timeline` for requesters. Reply questions are category-aware so schools get "Where are you based?" not "Where is your programme based?"
