// ============================================================
// n8n Code Node: VALIDATE
// Deterministic checks: extraction failure gate, enum validation,
// spam detection, email validation, fee parsing, age normalization,
// confidence scoring, and processing status assignment.
// ============================================================

const input = { ...$input.first().json };

// --- Helper: return extraction-failed result ---

function extractionFailedResult(inp, reason) {
  return [{
    json: {
      ...inp,
      enquiry_category: "unknown",
      sender_type: "unknown",
      sender_name: null,
      programme_name: null,
      programme_topic: null,
      target_age_range: null,
      location: null,
      format: "unknown",
      fee_text: null,
      fee_numeric: null,
      delivery_preference: null,
      timeline: null,
      contact_email: null,
      intent: "unclear",
      summary: "Extraction failed — raw message preserved for manual review",
      missing_fields: ["all"],
      evidence: {},
      processing_status: "extraction_failed",
      confidence_level: "low",
      validation_flags: [reason],
    }
  }];
}

// --- 1. Extraction Failure Gate ---

if (input._extractionFailed) {
  return extractionFailedResult(input, "extraction_failed");
}

// --- 1b. Empty / whitespace-only input ---

const trimmedMessage = (input.raw_message || "").trim();
if (!trimmedMessage) {
  return extractionFailedResult(input, "extraction_failed_empty_input");
}

// --- Initialize validation_flags ---

const validation_flags = [];

// --- 2. Enum Validation (defensive) ---

const ALLOWED = {
  enquiry_category: ["provider_opportunity", "school_request", "student_request", "organisation_request", "spam", "unknown"],
  sender_type: ["programme_provider", "school", "student", "organisation", "unknown"],
  format: ["in_person", "online", "hybrid", "unknown"],
  intent: ["partnership", "listing", "information_request", "support_request", "spam", "unclear"],
};

for (const [field, allowed] of Object.entries(ALLOWED)) {
  if (input[field] && !allowed.includes(input[field])) {
    validation_flags.push(`invalid_enum_${field}: "${input[field]}"`);
    input[field] = "unknown";
  }
}

// --- 3. Deterministic Spam Detection ---

const rawMessage = input.raw_message || "";

// Strip quoted text (single/double quotes) so references to spam don't trigger rules.
// E.g. a counsellor quoting "click here" in a scam warning won't be flagged.
const textForSpamCheck = rawMessage
  .replace(/'[^']*'/g, " ")
  .replace(/"[^"]*"/g, " ");

// Track strong vs weak spam signals separately.
// Strong: phrase matches and link shorteners (high-confidence spam indicators).
// Weak: suspicious TLDs alone (many legitimate providers use .xyz).
let strong_signal_count = 0;
let has_tld_signal = false;

// Phrase patterns (strong signals)
const spamPhrases = [
  /grow your linkedin/i,
  /check out our tool/i,
  /seo services/i,
  /lead generation/i,
  /\bcrypto\b/i,
  /\bforex\b/i,
  /click here/i,
  /make money/i,
  /\$5000\/day/i,
  /\$\d{4,}\/day/i,
];

for (const pattern of spamPhrases) {
  if (pattern.test(textForSpamCheck)) {
    strong_signal_count++;
    validation_flags.push(`spam_phrase: ${pattern.source}`);
  }
}

// Link shorteners (strong signal)
if (/(bit\.ly|tinyurl)/i.test(textForSpamCheck)) {
  strong_signal_count++;
  validation_flags.push("spam_link_shortener");
}

// Suspicious TLDs (weak signal — only contributes alongside strong signals)
if (/\.(xyz|tk)\b/i.test(textForSpamCheck) || /\.(xyz|tk)\b/i.test(input.from_email || "")) {
  has_tld_signal = true;
  validation_flags.push("spam_suspicious_tld");
}

// Total signal count: TLD only counts when combined with strong signals
const spam_signal_count = strong_signal_count + (has_tld_signal && strong_signal_count > 0 ? 1 : 0);

// The AI extraction provides context-aware classification. When the AI says the
// enquiry is legitimate (not spam/unknown) but deterministic rules find signals,
// use spam_suspected instead of hard spam — the AI understood the context.
const aiSaysLegitimate = input.enquiry_category &&
  !["spam", "unknown"].includes(input.enquiry_category);

// Apply spam signals.
// When the AI says the enquiry is legitimate, we trust its contextual understanding
// for single signals (e.g. "crypto" in an educational context). Only escalate to
// spam_suspected when there are 2+ strong signals despite AI disagreement.
if (spam_signal_count >= 2 && !aiSaysLegitimate) {
  input.enquiry_category = "spam";
  input.processing_status = "spam";
  validation_flags.push("spam_override_by_rules");
} else if (spam_signal_count >= 2 && aiSaysLegitimate) {
  // AI thinks it's legit but multiple spam signals — flag for review, don't override
  input.processing_status = "spam_suspected";
  validation_flags.push("spam_suspected_ai_disagrees");
} else if (strong_signal_count >= 1 && !aiSaysLegitimate) {
  // Single signal and AI agrees it's spam/unknown — flag as suspected
  if (!input.processing_status || input.processing_status === "ok") {
    input.processing_status = "spam_suspected";
  }
  validation_flags.push("spam_suspected_single_signal");
}
// When strong_signal_count === 1 && aiSaysLegitimate: trust the AI.
// The validation_flags still record the signal for auditability.

// --- 4. Email Validation ---

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (input.contact_email && !emailRegex.test(input.contact_email)) {
  validation_flags.push("invalid_contact_email");
  input.contact_email = null;
  if (!input.missing_fields) input.missing_fields = [];
  if (!input.missing_fields.includes("contact_email")) {
    input.missing_fields.push("contact_email");
  }
}

// --- 5. Contact Email Fallback ---

if (!input.contact_email && input.from_email && emailRegex.test(input.from_email)) {
  input.contact_email = input.from_email;
  validation_flags.push("contact_email_fallback_from_metadata");
}

// --- 6. Fee Normalization ---
// Extract the first recognisable currency amount from fee_text.
// Handles formats like "£6,000", "EUR 1,200", "$250,000 per student", "€2,900".

let fee_numeric = null;
if (input.fee_text) {
  // Match the first number that may contain commas or dots as thousands separators
  // e.g. "6,000", "2900", "4,800", "3 500", "250,000"
  const feeMatch = input.fee_text.match(/[\d][\d,.\s]*[\d]|[\d]+/);
  if (feeMatch) {
    // Remove thousands separators (commas and spaces), keep decimal point
    const cleaned = feeMatch[0].replace(/[,\s]/g, "");
    const parsed = parseFloat(cleaned);
    if (!isNaN(parsed)) {
      fee_numeric = parsed;
    }
  }
}
input.fee_numeric = fee_numeric;

// --- 7. Age Range Normalization ---

if (input.target_age_range) {
  let age = input.target_age_range;
  // "16 to 18" -> "16-18"
  age = age.replace(/(\d+)\s*to\s*(\d+)/i, "$1-$2");
  // "ages 14-21" -> "14-21"
  age = age.replace(/ages?\s*/i, "");
  // Trim whitespace
  age = age.trim();
  input.target_age_range = age;
}

// --- 8. Confidence Level ---

const missingCount = (input.missing_fields || []).length;
// Only downgrade confidence if spam signals actually changed the processing status
const hasSpamOverride = input.processing_status === "spam" || input.processing_status === "spam_suspected";

let confidence_level;
if (missingCount <= 2 && !hasSpamOverride) {
  confidence_level = "high";
} else if (missingCount <= 4 && !hasSpamOverride) {
  confidence_level = "medium";
} else {
  confidence_level = "low";
}
input.confidence_level = confidence_level;

// --- 9. Processing Status ---

if (!input.processing_status) {
  input.processing_status = "ok";
}

// --- Output ---

input.validation_flags = validation_flags;

return [{ json: input }];
