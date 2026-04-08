# Airtable Schema: Enquiries Table

## Column Definitions

| Column Name        | Airtable Type      | Source Node | Maps to Field          |
|--------------------|--------------------|-------------|------------------------|
| Raw Input          | Long text          | Set         | `raw_message`          |
| From Email         | Email              | Set         | `from_email`           |
| Source             | Single select      | Set         | `source`               |
| Enquiry Category   | Single select      | Extract     | `enquiry_category`     |
| Sender Type        | Single select      | Extract     | `sender_type`          |
| Sender Name        | Single line text   | Extract     | `sender_name`          |
| Programme Name     | Single line text   | Extract     | `programme_name`       |
| Programme Topic    | Single line text   | Extract     | `programme_topic`      |
| Age Range          | Single line text   | Extract     | `target_age_range`     |
| Location           | Single line text   | Extract     | `location`             |
| Format             | Single select      | Extract     | `format`               |
| Fee Text           | Single line text   | Extract     | `fee_text`             |
| Fee Numeric        | Number             | Validate    | `fee_numeric`          |
| Delivery Preference| Single line text   | Extract     | `delivery_preference`  |
| Timeline           | Single line text   | Extract     | `timeline`             |
| Contact Email      | Email              | Validate    | `contact_email`        |
| Intent             | Single select      | Extract     | `intent`               |
| Summary            | Long text          | Extract     | `summary`              |
| Missing Fields     | Long text          | Extract     | `missing_fields` (join with ", ") |
| Processing Status  | Single select      | Validate    | `processing_status`    |
| Confidence Level   | Single select      | Validate    | `confidence_level`     |
| Validation Flags   | Long text          | Validate    | `validation_flags` (join with ", ") |
| Priority Score     | Number             | Score       | `score`                |
| Priority Tier      | Single select      | Score       | `tier`                 |
| Score Breakdown    | Long text          | Score       | `factor_scores` (formatted) |
| Score Rationale    | Long text          | Score       | `factor_evidence` (formatted) |
| Reply Questions    | Long text          | Route       | `reply_questions` (join with "; ") |
| Next Action        | Single select      | Route       | `action`               |
| Action Note        | Long text          | Route       | `action_note`          |
| Needs Review       | Checkbox           | Route       | `needs_review`         |
| Draft Follow-Up    | Long text          | Reply       | `reply_draft`          |
| Timestamp          | Date (include time)| Set         | `timestamp`            |

## Single Select Options

**Enquiry Category:** provider_opportunity, school_request, student_request, organisation_request, spam, unknown

**Sender Type:** programme_provider, school, student, organisation, unknown

**Format:** in_person, online, hybrid, unknown

**Intent:** partnership, listing, information_request, support_request, spam, unclear

**Processing Status:** ok, spam, spam_suspected, extraction_failed

**Confidence Level:** high, medium, low

**Priority Tier:** high, medium, low, minimal, spam, failed

**Next Action:** schedule_call, request_info, share_options, manual_review, archive

**Source:** email, form, webhook, manual

## Essential Views (create first)

| View Name       | Filter                          | Sort              | Purpose                              |
|-----------------|---------------------------------|-------------------|--------------------------------------|
| All Enquiries   | (none)                          | Timestamp DESC    | Default view, all records            |
| High Priority   | Priority Tier = "high"          | Priority Score DESC | Partnership opportunities to act on |
| Needs Review    | Needs Review = checked          | Priority Score DESC | Failed extractions + edge cases    |

## Deferred Views (add during polish)

| View Name        | Filter                                              | Purpose                    |
|------------------|------------------------------------------------------|----------------------------|
| Needs Info       | Next Action = "request_info"                         | Leads needing follow-up    |
| School / Student | Enquiry Category in (school_request, student_request)| Non-provider enquiries     |
| Spam / Archived  | Processing Status in ("spam", "spam_suspected")      | Audit trail                |

## Airtable Field Formatting Notes

- **Score Breakdown**: Format as readable text in the Airtable write node:
  `Fit: ${fit}/25, Value: ${value}/25, Completeness: ${comp}/20, Contact: ${contact}/10, Strategic: ${strat}/20`

- **Score Rationale**: Combine factor evidence into one text block:
  `Fit: ${fit_evidence}. Value: ${value_evidence}. Completeness: ${comp_evidence}. Contact: ${contact_evidence}. Strategic: ${strat_evidence}.`

- **Missing Fields**: Join array with ", " before writing.

- **Validation Flags**: Join array with ", " before writing.

- **Reply Questions**: Join array with "; " before writing.
