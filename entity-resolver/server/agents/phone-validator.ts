import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Phone Number Validator agent.
 *
 * Backs the `phone-validator` markdown agent. Validates Indian phone numbers
 * against TRAI-assigned mobile ranges and produces a phone_score (0–20).
 *
 * Part of the Contacts validation rubric (contacts-validation.md):
 *   contacts_score = avg(location_score, phone_score, email_score) — each 0–20
 *
 * Phone scoring (0–20):
 *   20 — Valid mobile with +91 prefix (TRAI mobile range 6–9)
 *   18 — Valid mobile with 0 prefix or bare 10-digit mobile
 *   10 — Landline / toll-free (prefix 1–5 after +91) — structurally valid but unverified
 *    5 — Too many digits (> 12 total) or too few digits (< 10 total)
 *    2 — Other invalid format
 *    0 — Null / missing (SQL NULL, empty string, or literal "null")
 */
export const phoneValidatorAgent = createAgent({
  name: 'phone-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Phone Number Validator sub-agent.',
    'When given a phone_numbers value, call `validate_phone_number` once for the primary number.',
    'The tool returns a phone_score (0–20) per the contacts-validation.md rubric:',
    '  20 = valid mobile with +91 prefix (TRAI range 6–9)',
    '  18 = valid mobile with 0 prefix or bare 10-digit mobile',
    '  10 = landline/toll-free (prefix 1–5 after +91)',
    '   5 = too many (>12) or too few (<10) digits',
    '   2 = other invalid format',
    '   0 = null/missing/literal "null" string',
    'Apply judgment: a number that fails the regex but is clearly valid on inspection should be scored accordingly.',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"phone-validator","phone_score":<0-20>,"status":"VALID|INVALID|LANDLINE_WARNING|NULL_STRING","number":"<normalised E.164 or null>","note":"<one sentence or null>"}',
  ].join(' '),
  tools: {
    validate_phone_number: tool({
      description:
        'Validates an Indian phone number against TRAI mobile format rules. Returns a phone_score (0–20), verdict, and normalised E.164 form.',
      schema: z.object({
        record_id: z.string().describe('Facility unique_id.'),
        facility_name: z.string().describe('Facility name for context.'),
        phone: z.string().nullable().optional().describe('The officialPhone value to validate.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ record_id, facility_name, phone }) => {
        const runId = getActiveRunId();
        if (runId) emitAgentStart(runId, 'phone-validator');

        const result = (() => {
          // ── Null / missing ────────────────────────────────────────────────
          if (!phone || phone.trim() === '' || phone === 'null') {
            return {
              record_id,
              facility_name,
              phone,
              normalised: null,
              phone_score: 0,
              verdict: 'NULL_STRING' as const,
              notes: 'Phone number is null, empty, or the literal string "null".',
            };
          }

          // ── Strip everything except digits and leading + ───────────────────
          const stripped = phone.replace(/[^\d+]/g, '');
          const digits = stripped.replace(/\D/g, '');

          // ── Too few digits ────────────────────────────────────────────────
          if (digits.length < 10) {
            return {
              record_id,
              facility_name,
              phone,
              normalised: stripped,
              phone_score: 5,
              verdict: 'INVALID' as const,
              notes: `Too few digits (${digits.length}); minimum is 10.`,
            };
          }

          // ── Too many digits ───────────────────────────────────────────────
          if (digits.length > 12) {
            return {
              record_id,
              facility_name,
              phone,
              normalised: stripped,
              phone_score: 5,
              verdict: 'INVALID' as const,
              notes: `Too many digits (${digits.length}); maximum is 12.`,
            };
          }

          // ── Extract 10-digit subscriber number ────────────────────────────
          // Remove country code 91 if present
          let subscriber = digits;
          if (digits.length === 12 && digits.startsWith('91')) {
            subscriber = digits.slice(2);
          } else if (digits.length === 11 && digits.startsWith('0')) {
            subscriber = digits.slice(1);
          }

          if (subscriber.length !== 10) {
            return {
              record_id,
              facility_name,
              phone,
              normalised: stripped,
              phone_score: 2,
              verdict: 'INVALID' as const,
              notes: `Could not extract a 10-digit subscriber number from "${phone}".`,
            };
          }

          const prefix = parseInt(subscriber[0], 10);

          // ── Landline / toll-free (prefix 1–5) ────────────────────────────
          if (prefix >= 1 && prefix <= 5) {
            return {
              record_id,
              facility_name,
              phone,
              normalised: `+91${subscriber}`,
              phone_score: 10,
              verdict: 'LANDLINE_WARNING' as const,
              notes: 'Landline/toll-free prefix (1–5). STD-aware validation not implemented; treat as warning.',
            };
          }

          // ── Valid mobile (prefix 6–9) — check whether +91 was explicit ───
          if (prefix >= 6 && prefix <= 9) {
            const hasPlus91 = stripped.startsWith('+91') || (digits.length === 12 && digits.startsWith('91'));
            const hasZeroPrefix = phone.trim().startsWith('0') && digits.length === 11;
            const isBare10 = digits.length === 10;

            const score = hasPlus91 ? 20 : (hasZeroPrefix || isBare10) ? 18 : 18;
            return {
              record_id,
              facility_name,
              phone,
              normalised: `+91${subscriber}`,
              phone_score: score,
              verdict: 'VALID' as const,
              notes: null,
            };
          }

          // ── Other invalid format ──────────────────────────────────────────
          return {
            record_id,
            facility_name,
            phone,
            normalised: stripped,
            phone_score: 2,
            verdict: 'INVALID' as const,
            notes: `Unexpected subscriber prefix digit: ${prefix}.`,
          };
        })();

        if (runId) emitAgentDone(runId, 'phone-validator');
        return result;
      },
    }),
  },
});
