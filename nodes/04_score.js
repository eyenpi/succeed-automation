// ============================================================
// n8n Code Node: SCORE
// Deterministic category-aware scoring with 5 factors (100 pts).
// Each factor returns { score, evidence } for auditability.
// ============================================================

const input = { ...$input.first().json };

// --- Gate Checks ---

if (input.processing_status === "extraction_failed") {
  return [{
    json: {
      ...input,
      score: 0,
      tier: "failed",
      factor_scores: { fit_to_succeed: 0, value_and_actionability: 0, completeness: 0, contactability: 0, strategic_signal: 0 },
      factor_evidence: { fit_to_succeed: "Extraction failed", value_and_actionability: "N/A", completeness: "N/A", contactability: "N/A", strategic_signal: "N/A" },
    }
  }];
}

if (input.processing_status === "spam") {
  return [{
    json: {
      ...input,
      score: 0,
      tier: "spam",
      factor_scores: { fit_to_succeed: 0, value_and_actionability: 0, completeness: 0, contactability: 0, strategic_signal: 0 },
      factor_evidence: { fit_to_succeed: "Spam", value_and_actionability: "N/A", completeness: "N/A", contactability: "N/A", strategic_signal: "N/A" },
    }
  }];
}

// spam_suspected records are scored normally — they route to manual_review
// via the routing node but still get a meaningful score for human triage.

// --- Helper: check if age range overlaps Succeed's 14-19 target audience ---

function ageOverlapsSucceed(ageRange) {
  if (!ageRange) return false;
  const nums = ageRange.match(/\d+/g);
  if (!nums || nums.length === 0) return false;
  const min = parseInt(nums[0], 10);
  const max = nums.length > 1 ? parseInt(nums[nums.length - 1], 10) : min;
  // Succeed targets students aged 14-19
  return min <= 19 && max >= 14;
}

// --- Factor 1: Fit to Succeed (25 pts) ---

function scoreFit(d) {
  const cat = d.enquiry_category;
  const sender = d.sender_type;
  const hasAge = !!d.target_age_range;
  const hasTopic = !!d.programme_topic;
  const ageOverlaps = ageOverlapsSucceed(d.target_age_range);

  if (cat === "provider_opportunity") {
    if (sender === "programme_provider" && hasAge && ageOverlaps) {
      return { score: 25, evidence: `Programme provider targeting ${d.target_age_range} — direct Succeed audience fit` };
    }
    if (sender === "programme_provider" && hasAge && !ageOverlaps) {
      return { score: 8, evidence: `Programme provider targeting ${d.target_age_range} — outside Succeed's 14-19 audience` };
    }
    if (sender === "programme_provider") {
      return { score: 20, evidence: "Programme provider, age range not stated" };
    }
    if (sender === "organisation" && hasTopic) {
      return { score: 15, evidence: `Organisation with education-adjacent topic: ${d.programme_topic}` };
    }
    return { score: 10, evidence: "Organisation without clear education link" };
  }

  if (cat === "school_request") {
    if (sender === "school" && hasTopic) {
      return { score: 22, evidence: `School with relevant subject: ${d.programme_topic}` };
    }
    return { score: 18, evidence: "School without subject specificity" };
  }

  if (cat === "student_request") {
    if (hasTopic) {
      return { score: 18, evidence: `Student with specific interest: ${d.programme_topic}` };
    }
    return { score: 12, evidence: "Student without specific interest" };
  }

  // organisation_request, unknown
  return { score: 8, evidence: `Category: ${cat} — unclear audience fit` };
}

// --- Factor 2: Value and Actionability (25 pts) ---

function scoreValue(d) {
  const cat = d.enquiry_category;
  const intent = d.intent;
  const hasFee = !!d.fee_text || !!d.fee_numeric;
  const hasTopic = !!d.programme_topic;

  if (cat === "provider_opportunity") {
    if (intent === "partnership" && hasFee) {
      return { score: 25, evidence: `Partnership intent + fee: ${d.fee_text || d.fee_numeric} — strong commercial signal` };
    }
    if (intent === "partnership") {
      return { score: 18, evidence: "Partnership intent, no fee stated" };
    }
    if (intent === "listing" && hasFee) {
      return { score: 15, evidence: `Listing intent + fee: ${d.fee_text || d.fee_numeric}` };
    }
    if (intent === "listing") {
      return { score: 10, evidence: "Listing intent, no fee" };
    }
    return { score: 5, evidence: `Intent: ${intent} — unclear value` };
  }

  if (cat === "school_request" || cat === "student_request") {
    const hasNeed = d.summary && d.summary.length > 20;
    if (hasTopic && hasNeed) {
      return { score: 18, evidence: `Specific subject (${d.programme_topic}) + clear need stated` };
    }
    if (hasTopic) {
      return { score: 12, evidence: `Specific subject (${d.programme_topic}), vague need` };
    }
    return { score: 6, evidence: "No subject specificity" };
  }

  // organisation_request, unknown
  if (intent === "partnership") {
    return { score: 10, evidence: "Partnership intent stated, but organisation type" };
  }
  return { score: 3, evidence: `Intent: ${intent} — low actionability` };
}

// --- Factor 3: Completeness (20 pts) ---

function scoreCompleteness(d) {
  const cat = d.enquiry_category;

  let keyFields;
  if (cat === "provider_opportunity") {
    keyFields = ["sender_name", "programme_name", "programme_topic", "target_age_range", "location", "format", "fee_text", "contact_email"];
  } else if (cat === "school_request" || cat === "student_request") {
    keyFields = ["sender_name", "programme_topic", "target_age_range", "location", "delivery_preference", "timeline", "contact_email"];
  } else {
    keyFields = ["sender_name", "programme_name", "programme_topic", "target_age_range", "location", "format", "fee_text", "delivery_preference", "contact_email"];
  }

  const totalFields = keyFields.length;
  let populated = 0;
  for (const field of keyFields) {
    if (d[field] !== null && d[field] !== undefined && d[field] !== "" && d[field] !== "unknown") {
      populated++;
    }
  }

  let score;
  if (populated >= 6) score = 20;
  else if (populated >= 4) score = 14;
  else if (populated >= 2) score = 8;
  else score = 3;

  const label = cat === "provider_opportunity" ? "provider" : (cat === "school_request" || cat === "student_request") ? "requester" : "general";
  return {
    score,
    evidence: `${populated} of ${totalFields} ${label} key fields populated`,
  };
}

// --- Factor 4: Contactability (10 pts) ---

function scoreContactability(d) {
  if (d.contact_email) {
    const isFallback = (d.validation_flags || []).includes("contact_email_fallback_from_metadata");
    if (isFallback) {
      return { score: 6, evidence: `Email from metadata fallback: ${d.contact_email}` };
    }
    return { score: 10, evidence: `Direct contact email: ${d.contact_email}` };
  }
  return { score: 0, evidence: "No usable email" };
}

// --- Factor 5: Strategic Signal (20 pts, capped) ---

function scoreStrategic(d) {
  let total = 0;
  const signals = [];
  const raw = (d.raw_message || "").toLowerCase();

  // Fee >= 3000
  if (d.fee_numeric && d.fee_numeric >= 3000) {
    total += 5;
    signals.push(`Fee ${d.fee_text || d.fee_numeric} (+5)`);
  }

  // International location or language
  const internationalPattern = /\b(international|global|worldwide|countries)\b/i;
  const isInternational = internationalPattern.test(d.raw_message || "") ||
    (d.location && !["uk", "united kingdom", "england", "london", "edinburgh", "manchester", "birmingham", "usa", "united states", "new york", "boston"].includes(d.location.toLowerCase()));
  if (isInternational) {
    total += 5;
    signals.push(d.location ? `International: ${d.location} (+5)` : "Global reach language (+5)");
  }

  // Specific cohort detail
  const hasSpecificCohort = (d.programme_name && d.programme_name !== "unknown") ||
    (d.target_age_range && d.target_age_range !== "unknown") ||
    (d.programme_topic && d.programme_topic !== "unknown");
  if (hasSpecificCohort) {
    total += 4;
    signals.push("Specific cohort detail (+4)");
  }

  // Well-known institution
  const prestigePattern = /\b(oxford|cambridge|imperial|harvard|mit|stanford|yale|princeton|columbia|lse|ucl|eth|caltech)\b/i;
  if (prestigePattern.test(d.raw_message || "") || prestigePattern.test(d.programme_name || "")) {
    total += 4;
    const match = (d.raw_message || "").match(prestigePattern) || (d.programme_name || "").match(prestigePattern);
    signals.push(`${match[0]} (+4)`);
  }

  // Selective / competitive language
  if (/\b(selective|competitive|limited places|limited spots)\b/i.test(d.raw_message || "")) {
    total += 3;
    signals.push("Selective/competitive (+3)");
  }

  // Multiple countries / "50+ countries"
  if (/\b(\d+\+?\s*countries|multiple countries)\b/i.test(d.raw_message || "")) {
    total += 3;
    signals.push("Multi-country reach (+3)");
  }

  // Cap at 20
  const capped = Math.min(total, 20);
  const evidence = signals.length > 0
    ? signals.join("; ") + (total > 20 ? ` = ${total}, capped at 20` : "")
    : "No strategic signals";

  return { score: capped, evidence };
}

// --- Calculate All Factors ---

const fit = scoreFit(input);
const value = scoreValue(input);
const completeness = scoreCompleteness(input);
const contactability = scoreContactability(input);
const strategic = scoreStrategic(input);

const totalScore = fit.score + value.score + completeness.score + contactability.score + strategic.score;

// --- Tier Assignment ---

let tier;
if (totalScore >= 75) tier = "high";
else if (totalScore >= 45) tier = "medium";
else if (totalScore >= 20) tier = "low";
else tier = "minimal";

// --- Output ---

return [{
  json: {
    ...input,
    score: totalScore,
    tier,
    factor_scores: {
      fit_to_succeed: fit.score,
      value_and_actionability: value.score,
      completeness: completeness.score,
      contactability: contactability.score,
      strategic_signal: strategic.score,
    },
    factor_evidence: {
      fit_to_succeed: fit.evidence,
      value_and_actionability: value.evidence,
      completeness: completeness.evidence,
      contactability: contactability.evidence,
      strategic_signal: strategic.evidence,
    },
  }
}];
