// ============================================================
// n8n Code Node: PROCESS EXTRACTION
// Parses the OpenAI response from the HTTP Request node.
// Merges extracted fields with original input data.
// ============================================================

// Original input data (from the Build Extract Prompt node)
const promptNode = $('Build Extract Prompt').first().json;
const { _requestBody, ...originalInput } = promptNode;

// API response (from the HTTP Request node)
const apiResponse = $input.first().json;

// Check for API errors
if (apiResponse.error) {
  return [{
    json: {
      ...originalInput,
      _extractionFailed: true,
      _failureReason: apiResponse.error.message || 'OpenAI API error',
    }
  }];
}

// Check for missing choices
if (!apiResponse.choices || !apiResponse.choices[0]) {
  return [{
    json: {
      ...originalInput,
      _extractionFailed: true,
      _failureReason: 'No choices in API response',
    }
  }];
}

const message = apiResponse.choices[0].message;

// Handle model refusals (safety filters)
if (message.refusal) {
  return [{
    json: {
      ...originalInput,
      _extractionFailed: true,
      _failureReason: message.refusal,
    }
  }];
}

// Parse the structured output
try {
  const extracted = JSON.parse(message.content);

  // Convert evidence from array of {field, quote} to object for downstream nodes
  if (Array.isArray(extracted.evidence)) {
    const evidenceObj = {};
    for (const entry of extracted.evidence) {
      evidenceObj[entry.field] = entry.quote;
    }
    extracted.evidence = evidenceObj;
  }

  return [{ json: { ...originalInput, ...extracted } }];
} catch (e) {
  return [{
    json: {
      ...originalInput,
      _extractionFailed: true,
      _failureReason: 'Failed to parse extraction response: ' + e.message,
    }
  }];
}
