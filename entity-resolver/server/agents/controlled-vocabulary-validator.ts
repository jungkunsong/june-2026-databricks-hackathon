import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Controlled Vocabulary Validator agent.
 *
 * Validates that `facilityTypeId` and `operatorTypeId` columns only contain
 * values from their canonical sets. Intentionally kept out of master.sql
 * because the correct fix varies per record and requires agent or human
 * confirmation — new unexpected values will appear as new data sources are
 * ingested.
 *
 * Canonical sets (June 2026):
 *   facilityTypeId  → hospital | clinic | dentist | pharmacy | nursing_home
 *   operatorTypeId  → private | public
 *
 * Special cases:
 *   facilityTypeId = "doctor"     → Warning (semantically invalid for a facility)
 *   operatorTypeId = "government" → Warning (synonym for "public" — normalize)
 *   NULL in either column         → Warning (missing classification)
 *   Any other value               → Error (not in canonical set)
 */
export const controlledVocabularyValidatorAgent = createAgent({
  name: 'controlled-vocabulary-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Controlled Vocabulary Validator sub-agent.',
    'When given facility records, call `validate_controlled_vocabulary` for each record.',
    'After all checks complete, return a structured markdown table grouped by column_name,',
    'and a JSON summary counting records by status (Valid, Warning, Error).',
    'For Warning and Error records, suggest the correct canonical value where possible.',
    'facilityTypeId canonical values: hospital, clinic, dentist, pharmacy, nursing_home.',
    'operatorTypeId canonical values: private, public.',
    'Treat "government" as a synonym for "public" and recommend normalization.',
    'Treat "doctor" in facilityTypeId as semantically invalid for a facility record.',
  ].join(' '),
  tools: {
    validate_controlled_vocabulary: tool({
      description:
        'Validates facilityTypeId and operatorTypeId against their canonical value sets. Returns a status of Valid, Warning, or Error for each column, with a suggested correction where applicable.',
      schema: z.object({
        record_id: z.string().describe('The unique_id of the facility record.'),
        facility_name: z.string().describe('The facility name from the database.'),
        facility_type_id: z
          .string()
          .nullable()
          .describe('The facilityTypeId value from the record.'),
        operator_type_id: z
          .string()
          .nullable()
          .describe('The operatorTypeId value from the record.'),
      }),
      annotations: { effect: 'read' },
      execute: ({ record_id, facility_name, facility_type_id, operator_type_id }) => {
        const VALID_FACILITY_TYPES = new Set([
          'hospital',
          'clinic',
          'dentist',
          'pharmacy',
          'nursing_home',
        ]);
        const VALID_OPERATOR_TYPES = new Set(['private', 'public']);

        // ── Validate facilityTypeId ─────────────────────────────────────────
        let facilityTypeStatus: 'Valid' | 'Warning' | 'Error';
        let facilityTypeIssue: string | null = null;
        let facilityTypeSuggestion: string | null = null;

        if (facility_type_id === null) {
          facilityTypeStatus = 'Warning';
          facilityTypeIssue = 'NULL value — facility type is unclassified.';
        } else if (facility_type_id === 'doctor') {
          facilityTypeStatus = 'Warning';
          facilityTypeIssue =
            '"doctor" is semantically invalid for a facility type (describes a person, not a facility).';
          facilityTypeSuggestion = 'Review record — likely should be "clinic" or "hospital".';
        } else if (!VALID_FACILITY_TYPES.has(facility_type_id)) {
          facilityTypeStatus = 'Error';
          facilityTypeIssue = `"${facility_type_id}" is not in the canonical set: hospital, clinic, dentist, pharmacy, nursing_home.`;
          // Attempt a simple suggestion based on substring matching
          const lower = facility_type_id.toLowerCase();
          if (lower.includes('hospital')) {
            facilityTypeSuggestion = 'hospital';
          } else if (lower.includes('clinic')) {
            facilityTypeSuggestion = 'clinic';
          } else if (lower.includes('dent')) {
            facilityTypeSuggestion = 'dentist';
          } else if (lower.includes('pharm')) {
            facilityTypeSuggestion = 'pharmacy';
          } else if (lower.includes('nurs')) {
            facilityTypeSuggestion = 'nursing_home';
          } else {
            facilityTypeSuggestion = null;
          }
        } else {
          facilityTypeStatus = 'Valid';
        }

        // ── Validate operatorTypeId ─────────────────────────────────────────
        let operatorTypeStatus: 'Valid' | 'Warning' | 'Error';
        let operatorTypeIssue: string | null = null;
        let operatorTypeSuggestion: string | null = null;

        if (operator_type_id === null) {
          operatorTypeStatus = 'Warning';
          operatorTypeIssue = 'NULL value — operator type is unclassified.';
        } else if (operator_type_id === 'government') {
          operatorTypeStatus = 'Warning';
          operatorTypeIssue = '"government" is a synonym for "public" — normalize to canonical value.';
          operatorTypeSuggestion = 'public';
        } else if (!VALID_OPERATOR_TYPES.has(operator_type_id)) {
          operatorTypeStatus = 'Error';
          operatorTypeIssue = `"${operator_type_id}" is not in the canonical set: private, public.`;
          const lower = operator_type_id.toLowerCase();
          if (lower.includes('gov') || lower.includes('pub') || lower.includes('state')) {
            operatorTypeSuggestion = 'public';
          } else if (lower.includes('priv')) {
            operatorTypeSuggestion = 'private';
          } else {
            operatorTypeSuggestion = null;
          }
        } else {
          operatorTypeStatus = 'Valid';
        }

        // ── Overall record status ───────────────────────────────────────────
        const overallStatus =
          facilityTypeStatus === 'Error' || operatorTypeStatus === 'Error'
            ? 'Error'
            : facilityTypeStatus === 'Warning' || operatorTypeStatus === 'Warning'
              ? 'Warning'
              : 'Valid';

        const runId = getActiveRunId();
        if (runId) { emitAgentStart(runId, 'controlled-vocabulary-validator'); emitAgentDone(runId, 'controlled-vocabulary-validator'); }
        return {
          record_id,
          facility_name,
          facility_type_id,
          facility_type_status: facilityTypeStatus,
          facility_type_issue: facilityTypeIssue,
          facility_type_suggestion: facilityTypeSuggestion,
          operator_type_id,
          operator_type_status: operatorTypeStatus,
          operator_type_issue: operatorTypeIssue,
          operator_type_suggestion: operatorTypeSuggestion,
          overall_status: overallStatus,
        };
      },
    }),
  },
});
