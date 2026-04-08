// ============================================================
// n8n Code Node: EXTRACT
// Calls OpenAI Structured Outputs via fetch + raw JSON Schema.
// No external modules — works on n8n Cloud.
// ============================================================

const input = $input.first().json;
const rawMessage = input.raw_message;
const fromEmail = input.from_email;
const source = input.source;

// --- JSON Schema (replaces Zod for n8n Cloud compatibility) ---

const jsonSchema = {
  name: "enquiry_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      enquiry_category: {
        type: "string",
        enum: ["provider_opportunity", "school_request", "student_request", "organisation_request", "spam", "unknown"]
      },
      sender_type: {
        type: "string",
        enum: ["programme_provider", "school", "student", "organisation", "unknown"]
      },
      sender_name: { type: ["string", "null"] },
      programme_name: { type: ["string", "null"] },
      programme_topic: { type: ["string", "null"] },
      target_age_range: { type: ["string", "null"] },
      location: { type: ["string", "null"] },
      format: {
        type: "string",
        enum: ["in_person", "online", "hybrid", "unknown"]
      },
      fee_text: { type: ["string", "null"] },
      delivery_preference: { type: ["string", "null"] },
      timeline: { type: ["string", "null"] },
      contact_email: { type: ["string", "null"] },
      intent: {
        type: "string",
        enum: ["partnership", "listing", "information_request", "support_request", "spam", "unclear"]
      },
      summary: { type: "string" },
      missing_fields: {
        type: "array",
        items: { type: "string" }
      },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            quote: { type: "string" }
          },
          required: ["field", "quote"],
          additionalProperties: false
        }
      }
    },
    required: [
      "enquiry_category", "sender_type", "sender_name", "programme_name",
      "programme_topic", "target_age_range", "location", "format",
      "fee_text", "delivery_preference", "timeline", "contact_email",
      "intent", "summary", "missing_fields", "evidence"
    ],
    additionalProperties: false
  }
};

// --- Extraction Prompt ---

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

// --- API Call via fetch ---

try {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${$env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: jsonSchema,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return [{
      json: {
        ...input,
        _extractionFailed: true,
        _failureReason: data.error?.message || `HTTP ${response.status}`,
      }
    }];
  }

  const message = data.choices[0].message;

  // Handle model refusals (safety filters)
  if (message.refusal) {
    return [{
      json: {
        ...input,
        _extractionFailed: true,
        _failureReason: message.refusal,
      }
    }];
  }

  const extracted = JSON.parse(message.content);
  return [{ json: { ...input, ...extracted } }];

} catch (e) {
  return [{
    json: {
      ...input,
      _extractionFailed: true,
      _failureReason: e.message,
    }
  }];
}
