// ============================================================
// n8n Code Node: ROUTE
// Deterministic action assignment via rule matrix, overrides,
// needs_review flags, and reply question generation.
// ============================================================

const input = { ...$input.first().json };

// --- Reply Questions Mapping (category-aware) ---

const PROVIDER_QUESTIONS = {
  fee_text: "Could you share your programme's fee structure?",
  target_age_range: "What age range is your programme designed for?",
  programme_name: "What is the name of your programme?",
  programme_topic: "What subject area does your programme focus on?",
  location: "Where is your programme based?",
  format: "Is your programme in-person, online, or hybrid?",
};

const REQUESTER_QUESTIONS = {
  target_age_range: "What age range are your students?",
  programme_topic: "What subject areas are you most interested in?",
  location: "Where are you based?",
  delivery_preference: "Do you have a preference for in-person, online, or overseas programmes?",
  timeline: "When are you looking for programmes — this summer, next term, or another timeframe?",
};

// Fields excluded from reply_questions (internal/system)
const EXCLUDED_FIELDS = ["sender_name", "contact_email", "from_email", "evidence", "summary", "missing_fields"];

function generateReplyQuestions(d) {
  const questions = [];
  const missingFields = d.missing_fields || [];
  const cat = d.enquiry_category;

  const questionMap = cat === "provider_opportunity" ? PROVIDER_QUESTIONS : REQUESTER_QUESTIONS;

  for (const field of missingFields) {
    if (EXCLUDED_FIELDS.includes(field)) continue;
    if (questionMap[field]) {
      questions.push(questionMap[field]);
    }
  }

  // Generic email question if contact is missing
  if (!d.contact_email && !missingFields.includes("contact_email")) {
    // contact_email is missing but not in missing_fields — add generic
  }
  if (missingFields.includes("contact_email") || (!d.contact_email && !d.from_email)) {
    questions.push("What is the best email to reach you?");
  }

  return questions;
}

// --- Routing Rule Matrix (first match wins) ---

const cat = input.enquiry_category;
const tier = input.tier;
const status = input.processing_status;
const hasContactEmail = !!input.contact_email;
const hasFromEmail = !!input.from_email;
const hasAnyContact = hasContactEmail || hasFromEmail;

let action = "manual_review";
let action_note = null;
let needs_review = false;

// Rule 1: Extraction failed
if (status === "extraction_failed") {
  action = "manual_review";
  needs_review = true;
}
// Rule 2: Hard spam
else if (status === "spam") {
  action = "archive";
}
// Rule 3: Suspected spam
else if (status === "spam_suspected") {
  action = "manual_review";
  needs_review = true;
}
// Rule 4: Provider, high/medium tier, has contact email
else if (cat === "provider_opportunity" && (tier === "high" || tier === "medium") && hasContactEmail) {
  action = "schedule_call";
}
// Rule 5: Provider, high/medium tier, no contact email
else if (cat === "provider_opportunity" && (tier === "high" || tier === "medium") && !hasContactEmail) {
  action = "request_info";
}
// Rule 6: Provider, low/minimal tier
else if (cat === "provider_opportunity" && (tier === "low" || tier === "minimal")) {
  action = "request_info";
}
// Rule 7: School/student, high/medium tier, has contact email
else if ((cat === "school_request" || cat === "student_request") && (tier === "high" || tier === "medium") && hasContactEmail) {
  action = "share_options";
}
// Rule 8: School/student, high/medium tier, no contact email
else if ((cat === "school_request" || cat === "student_request") && (tier === "high" || tier === "medium") && !hasContactEmail) {
  action = "manual_review";
}
// Rule 9: School/student, low tier, has contact email
else if ((cat === "school_request" || cat === "student_request") && tier === "low" && hasContactEmail) {
  action = "request_info";
}
// Rule 10: School/student, low/minimal tier, no contact email
else if ((cat === "school_request" || cat === "student_request") && (tier === "low" || tier === "minimal") && !hasContactEmail) {
  action = "manual_review";
}
// Rule 11: Organisation/unknown
else if (cat === "organisation_request" || cat === "unknown") {
  action = "manual_review";
}

// --- Overrides ---

// Override 1: No-contact — downgrade outbound actions if no contact channel at all
if (!hasAnyContact && ["schedule_call", "request_info", "share_options"].includes(action)) {
  action_note = `Downgraded to manual_review: no contact channel available`;
  action = "manual_review";
  needs_review = true;
}

// Override 2: Contact-email — downgrade schedule_call if only from_email (no direct contact_email)
if (action === "schedule_call" && !hasContactEmail && hasFromEmail) {
  action_note = "Downgraded from schedule_call: no direct contact email";
  action = "request_info";
}

// Override 3: Low-confidence review flag (skip for spam/archive — those are already handled)
if (input.confidence_level === "low" && action !== "archive") {
  needs_review = true;
}

// Override 5: Extraction failure review flag
if (status === "extraction_failed") {
  needs_review = true;
}

// --- Generate Reply Questions ---

const reply_questions = generateReplyQuestions(input);

// --- Output ---

return [{
  json: {
    ...input,
    action,
    action_note,
    needs_review,
    reply_questions,
  }
}];
