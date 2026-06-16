import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Phone Number Validator agent.
 *
 * Backs the `phone-validator` markdown agent. Validates Indian phone numbers
 * against TRAI-assigned mobile ranges and flags data quality issues like
 * literal "null" strings, digit-count anomalies, and shared numbers across
 * records (a merge signal).
 */
export const phoneValidatorAgent = createAgent({
  name: 'phone-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Phone Number Validator sub-agent.',
    'When given a phone_numbers value, call `validate_phone_number` once for the primary number.',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"phone-validator","status":"VALID|INVALID|LANDLINE_WARNING|NULL_STRING","number":"<normalised or null>","note":"<one sentence or null>"}',
  ].join(' '),
  tools: {
    validate_phone_number: tool({
      description:
        'Validates an Indian phone number against TRAI mobile format rules and returns a verdict and normalised form.',
      schema: z.object({
        phone: z.string().describe('The raw phone number string from the database.'),
        facility_name: z.string().describe('The facility name, for context in the output.'),
        record_id: z.string().describe('The unique_id of the facility record being checked.'),
      }),
      annotations: { effect: 'read' },
      execute: ({ phone, facility_name, record_id }) => {
        const runId = getActiveRunId();
        if (runId) emitAgentStart(runId, 'phone-validator');
        const result = (() => {
        // ── Null / empty guard ──────────────────────────────────────────────
        if (!phone || phone.trim() === '' || phone.trim().toLowerCase() === 'null') {
          return {
            record_id,
            facility_name,
            phone,
            normalised: null,
            verdict: 'NULL_STRING' as const,
            notes: 'Literal "null" string or empty — should be SQL NULL.',
          };
        }

        // ── Normalise: strip everything except digits and leading + ─────────
        const stripped = phone.replace(/[^\d+]/g, '');
        // Remove leading + for digit-count checks
        const digitsOnly = stripped.replace(/^\+/, '');

        const digitCount = digitsOnly.length;

        // ── Too few digits ──────────────────────────────────────────────────
        if (digitCount < 10) {
          return {
            record_id,
            facility_name,
            phone,
            normalised: stripped,
            verdict: 'INVALID' as const,
            notes: `Too few digits (${digitCount} < 10).`,
          };
        }

        // ── Too many digits ─────────────────────────────────────────────────
        if (digitCount > 12) {
          return {
            record_id,
            facility_name,
            phone,
            normalised: stripped,
            verdict: 'INVALID' as const,
            notes: `Too many digits (${digitCount} > 12) — possible duplicate digit or STD code prepended.`,
          };
        }

        // ── Extract the 10-digit subscriber number ──────────────────────────
        // Formats: +91XXXXXXXXXX | 91XXXXXXXXXX | 0XXXXXXXXXX | XXXXXXXXXX
        let subscriber: string;
        if (digitsOnly.startsWith('91') && digitCount === 12) {
          subscriber = digitsOnly.slice(2);
        } else if (digitsOnly.startsWith('0') && digitCount === 11) {
          subscriber = digitsOnly.slice(1);
        } else if (digitCount === 10) {
          subscriber = digitsOnly;
        } else {
          return {
            record_id,
            facility_name,
            phone,
            normalised: stripped,
            verdict: 'INVALID' as const,
            notes: 'Unrecognised format — could not extract 10-digit subscriber number.',
          };
        }

        const prefix = parseInt(subscriber[0], 10);

        // ── Landline / toll-free (prefix 1–5) ──────────────────────────────
        if (prefix >= 1 && prefix <= 5) {
          return {
            record_id,
            facility_name,
            phone,
            normalised: `+91${subscriber}`,
            verdict: 'LANDLINE_WARNING' as const,
            notes: 'Landline/toll-free prefix (1–5). STD-aware validation not implemented; treat as warning.',
          };
        }

        // ── Valid mobile (prefix 6–9) ───────────────────────────────────────
        if (prefix >= 6 && prefix <= 9) {
          return {
            record_id,
            facility_name,
            phone,
            normalised: `+91${subscriber}`,
            verdict: 'VALID' as const,
            notes: null,
          };
        }

        return {
          record_id,
          facility_name,
          phone,
          normalised: stripped,
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
