// ============================================================
// n8n Code Node: PROCESS REPLY
// Parses the OpenAI response for the draft email.
// ============================================================

// Original input data (from the Build Reply Prompt node)
const promptNode = $('Build Reply Prompt').first().json;
const { _requestBody, ...originalInput } = promptNode;

// API response (from the HTTP Request node)
const apiResponse = $input.first().json;

// Check for API errors
if (apiResponse.error) {
  return [{
    json: {
      ...originalInput,
      reply_draft: "DRAFT_FAILED",
      draft_error: apiResponse.error.message || 'OpenAI API error',
    }
  }];
}

if (!apiResponse.choices || !apiResponse.choices[0]) {
  return [{
    json: {
      ...originalInput,
      reply_draft: "DRAFT_FAILED",
      draft_error: 'No choices in API response',
    }
  }];
}

const replyDraft = apiResponse.choices[0].message.content;
return [{ json: { ...originalInput, reply_draft: replyDraft } }];
