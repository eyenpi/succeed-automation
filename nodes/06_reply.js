// ============================================================
// n8n Code Node: REPLY
// Generates AI draft follow-up emails via fetch.
// No external modules — works on n8n Cloud.
// Only runs for schedule_call, request_info, share_options.
// ============================================================

const input = $input.first().json;

// --- Guard: Skip actions that don't need a reply ---

if (["archive", "manual_review"].includes(input.action)) {
  return [{ json: { ...input, reply_draft: "NO_RESPONSE" } }];
}

// --- Build Reply Prompt ---

const senderName = input.sender_name || "Unknown sender";
const programmeName = input.programme_name || "Not specified";
const programmeTopic = input.programme_topic || "Not specified";
const questionsText = (input.reply_questions && input.reply_questions.length > 0)
  ? input.reply_questions.join("; ")
  : "None";

const systemPrompt = `You are writing a follow-up email on behalf of Succeed, an education platform that connects high-school and early-university students with enrichment programmes and academic experiences.

Enquiry context:
- Sender: ${senderName}
- Type: ${input.sender_type}
- Category: ${input.enquiry_category}
- Programme: ${programmeName}
- Topic: ${programmeTopic}
- Summary: ${input.summary}
- Priority: ${input.tier} (score: ${input.score}/100)
- Action: ${input.action}
- Questions to ask: ${questionsText}

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
- Reference specific details from the enquiry to show this is not a template.`;

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
        { role: "user", content: `Write a ${input.action} follow-up email for this enquiry.` },
      ],
      max_completion_tokens: 300,
      temperature: 0.7,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return [{
      json: {
        ...input,
        reply_draft: "DRAFT_FAILED",
        draft_error: data.error?.message || `HTTP ${response.status}`,
      }
    }];
  }

  const replyDraft = data.choices[0].message.content;
  return [{ json: { ...input, reply_draft: replyDraft } }];

} catch (e) {
  return [{
    json: {
      ...input,
      reply_draft: "DRAFT_FAILED",
      draft_error: e.message,
    }
  }];
}
