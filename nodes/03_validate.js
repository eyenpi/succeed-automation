// ============================================================
// n8n Code Node: VALIDATE
// Deterministic checks: extraction failure gate, enum validation,
// spam detection, email validation, fee parsing, age normalization,
// confidence scoring, and processing status assignment.
// ============================================================

const input = { ...$input.first().json };

// --- 1. Extraction Failure Gate ---

if (input._extractionFailed) {
  return [{
    json: {
      ...input,
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
      validation_flags: ["extraction_failed"],
    }
  }];
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

const rawLower = (input.raw_message || "").toLowerCase();
let spam_signal_count = 0;

// Phrase patterns
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
  if (pattern.test(input.raw_message || "")) {
    spam_signal_count++;
    validation_flags.push(`spam_phrase: ${pattern.source}`);
  }
}

// Suspicious TLDs
if (/\.(xyz|tk)\b/i.test(input.raw_message || "") || /\.(xyz|tk)\b/i.test(input.from_email || "")) {
  spam_signal_count++;
  validation_flags.push("spam_suspicious_tld");
}

// Link shorteners
if (/(bit\.ly|tinyurl)/i.test(input.raw_message || "")) {
  spam_signal_count++;
  validation_flags.push("spam_link_shortener");
}

// Apply spam signals
if (spam_signal_count >= 2) {
  input.enquiry_category = "spam";
  input.processing_status = "spam";
  validation_flags.push("spam_override_by_rules");
} else if (spam_signal_count === 1) {
  if (!input.processing_status || input.processing_status === "ok") {
    input.processing_status = "spam_suspected";
  }
  validation_flags.push("spam_suspected_single_signal");
}

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

let fee_numeric = null;
if (input.fee_text) {
  const cleaned = input.fee_text.replace(/[^0-9.]/g, "");
  const parsed = parseFloat(cleaned);
  if (!isNaN(parsed)) {
    fee_numeric = parsed;
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
const hasSpamOverride = spam_signal_count > 0;

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
