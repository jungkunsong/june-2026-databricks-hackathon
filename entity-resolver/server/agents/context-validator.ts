import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Context Validator agent.
 *
 * Backs the `context-validator` markdown agent. Scores each facility's
 * contextual fields across six sub-scores, producing a context_score (0–20)
 * per context-validation.md.
 *
 * Sub-scores:
 *   1. Operational field coverage     (0–4)  — specialties, procedure, equipment, capability
 *   2. Description–name corroboration (0–4)  — anchor word from name present in description
 *   3. Specialty–description consistency (0–4) — description doesn't contradict specialties
 *   4. Numeric field presence         (0–4)  — numberDoctors and capacity populated
 *   5. Doctor-to-capacity ratio       (0–2)  — numberDoctors ≤ capacity
 *   6. Classification validity        (0–6)  — type-aware bounds (6a) + vocab compliance (6b+6c)
 *
 * Score labels: 17–20 Strong | 12–16 Good | 7–11 Moderate | 3–6 Weak | 0–2 Poor
 */
export const contextValidatorAgent = createAgent({
  name: 'context-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Context Validator sub-agent.',
    'When called, invoke `score_context` once with the provided fields.',
    'The tool computes all six sub-scores per context-validation.md. Review the result and apply judgment:',
    '  - Treat "null" strings as missing data (pipeline artifact, not a facility quality failure).',
    '  - Extend the 15-keyword specialty list if a clearly valid specialty is present but unlisted.',
    '  - Do not penalise a high doctor-to-capacity ratio if the facility type makes it plausible (e.g. outpatient clinic).',
    '  - Flag boilerplate descriptions that appear identical across multiple chain facilities.',
    '  - For new facilityTypeId/operatorTypeId values not in the canonical set, evaluate on merit rather than auto-scoring 1.',
    'Return ONLY a compact JSON object — no markdown, no prose:',
    '{"agent":"context-validator","context_score":<0-20>,"grade":"Strong|Good|Moderate|Weak|Poor","operational_coverage_score":<0-4>,"description_name_score":<0-4>,"specialty_consistency_score":<0-4>,"numeric_presence_score":<0-4>,"ratio_score":<0-2>,"classification_score":<0-6>,"flags":<array>}',
  ].join(' '),
  tools: {
    score_context: tool({
      description:
        'Scores a facility record across six sub-scores per context-validation.md, producing a context_score (0–20).',
      schema: z.object({
        facility_name: z.string().describe('Facility name — used for description anchor-word check.'),
        facility_type_id: z.string().nullable().optional().describe('facilityTypeId value (e.g. "hospital", "clinic").'),
        operator_type_id: z.string().nullable().optional().describe('operatorTypeId value (e.g. "private", "public").'),
        specialties: z.string().nullable().optional().describe('JSON array string or comma-separated specialties.'),
        procedure: z.string().nullable().optional().describe('JSON array string of procedures.'),
        equipment: z.string().nullable().optional().describe('JSON array string of equipment.'),
        capability: z.string().nullable().optional().describe('JSON array string of capabilities.'),
        description: z.string().nullable().optional().describe('Free-text facility description.'),
        number_doctors: z.string().nullable().optional().describe('numberDoctors field (string, may be "null").'),
        capacity: z.string().nullable().optional().describe('capacity field (string, may be "null").'),
      }),
      annotations: { effect: 'read' },
      execute: async ({
        facility_name,
        facility_type_id,
        operator_type_id,
        specialties,
        procedure,
        equipment,
        capability,
        description,
        number_doctors,
        capacity,
      }) => {
        const runId = getActiveRunId();
        if (runId) emitAgentStart(runId, 'context-validator');

        const flags: string[] = [];

        // ── Helpers ───────────────────────────────────────────────────────────
        function parseArray(val: string | null | undefined): string[] {
          if (!val || val === 'null' || val.trim() === '') return [];
          try {
            const parsed = JSON.parse(val);
            if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string' && x.trim() !== '');
          } catch {
            // Not JSON — try comma-split
            return val.split(',').map((s) => s.trim()).filter((s) => s !== '');
          }
          return [];
        }

        function parseNum(val: string | null | undefined): number | null {
          if (!val || val === 'null' || val.trim() === '') return null;
          const n = parseFloat(val.replace(/[^0-9.]/g, ''));
          return isNaN(n) ? null : n;
        }

        function isPopulated(arr: string[]): boolean {
          return arr.length > 0;
        }

        // ── Parse fields ──────────────────────────────────────────────────────
        const specArr = parseArray(specialties);
        const procArr = parseArray(procedure);
        const equipArr = parseArray(equipment);
        const capArr = parseArray(capability);
        const desc = (description && description !== 'null' && description.trim() !== '') ? description.trim() : null;
        const descLen = desc ? desc.length : 0;
        const doctorsNum = parseNum(number_doctors);
        const capacityNum = parseNum(capacity);

        // ── Sub-score 1: Operational field coverage (0–4) ────────────────────
        const operationalCoverageScore =
          (isPopulated(specArr) ? 1 : 0) +
          (isPopulated(procArr) ? 1 : 0) +
          (isPopulated(equipArr) ? 1 : 0) +
          (isPopulated(capArr) ? 1 : 0);

        if (operationalCoverageScore === 0) {
          flags.push('No operational array fields populated — no verifiable clinical profile.');
        }

        // ── Sub-score 2: Description–name corroboration (0–4) ────────────────
        // Anchor word: first word of name, skip titles/honorifics and ≤4-char words
        const SKIP_TITLES = new Set(['dr.', 'dr', 'the', 'sri', 'shri', 'shree', 'smt.', 'smt', 'late']);
        const nameWords = facility_name.split(/\s+/);
        let anchorWord = '';
        for (const w of nameWords) {
          const lower = w.toLowerCase().replace(/[^a-z]/g, '');
          if (!SKIP_TITLES.has(w.toLowerCase()) && lower.length > 4) {
            anchorWord = lower;
            break;
          }
        }

        let descriptionNameScore: number;
        if (!desc) {
          descriptionNameScore = 0;
        } else if (anchorWord.length === 0 || anchorWord.length <= 4) {
          descriptionNameScore = 1; // description present but unverifiable by name
        } else if (!desc.toLowerCase().includes(anchorWord)) {
          descriptionNameScore = 1; // description does not reference facility by name
          if (descLen > 50) {
            flags.push('Description is substantive but does not reference the facility by name — possible boilerplate.');
          }
        } else if (descLen < 50) {
          descriptionNameScore = 2; // name confirmed but too thin
        } else if (descLen < 200) {
          descriptionNameScore = 3;
        } else {
          descriptionNameScore = 4;
        }

        // ── Sub-score 3: Specialty–description consistency (0–4) ─────────────
        // 15-keyword vocabulary (substrings — covers camelCase and natural language)
        const SPECIALTY_KEYWORDS = [
          'cardiology', 'oncology', 'orthopedic', 'orthopaedic',
          'neurology', 'neurosurgery', 'ophthalmology',
          'gynecology', 'gynaecology', 'pediatric', 'paediatric',
          'urology', 'gastroenterology', 'dermatology', 'psychiatry',
          'radiology', 'pathology', 'pulmonology', 'nephrology',
        ];

        let specialtyConsistencyScore: number;
        if (!isPopulated(specArr) || !desc || descLen < 50) {
          specialtyConsistencyScore = 0; // not enough data
        } else {
          const descLower = desc.toLowerCase();
          const specLower = specArr.join(' ').toLowerCase();
          const descKwHits = SPECIALTY_KEYWORDS.filter((kw) => descLower.includes(kw)).length;
          const specKwHits = SPECIALTY_KEYWORDS.filter((kw) => specLower.includes(kw)).length;

          if (descKwHits > 0 && specKwHits < descKwHits) {
            specialtyConsistencyScore = 1; // contradiction
            flags.push('Description names a specialty not present in the specialties array — possible inconsistency.');
          } else if (descKwHits === 0) {
            specialtyConsistencyScore = 2; // neutral — description covers other aspects
          } else {
            specialtyConsistencyScore = 3; // positive corroboration
          }
        }

        // ── Sub-score 4: Numeric field presence (0–4) ────────────────────────
        const doctorsPresent = doctorsNum !== null && doctorsNum > 0;
        const capacityPresent = capacityNum !== null && capacityNum > 0;
        const numericPresenceScore = (doctorsPresent ? 2 : 0) + (capacityPresent ? 2 : 0);

        if (number_doctors === 'null' || capacity === 'null') {
          flags.push('numberDoctors or capacity stored as literal "null" string — ingestion pipeline issue, not a facility data failure.');
        }

        // ── Sub-score 5: Doctor-to-capacity ratio (0–2) ──────────────────────
        let ratioScore: number;
        if (!doctorsPresent || !capacityPresent) {
          ratioScore = 0; // not enough data — no penalty
        } else if (doctorsNum! > capacityNum!) {
          ratioScore = 0;
          flags.push(`Impossible ratio: numberDoctors (${doctorsNum}) > capacity (${capacityNum}) — likely sourced from mismatched pages.`);
        } else {
          ratioScore = 2;
        }

        // ── Sub-score 6: Classification validity (0–6) ───────────────────────
        const VALID_FACILITY_TYPES = new Set(['hospital', 'clinic', 'dentist', 'pharmacy', 'nursing_home']);
        const VALID_OPERATOR_TYPES = new Set(['private', 'public']);

        // 6a: facilityTypeId-aware numeric bounds (0–2)
        const TYPE_BOUNDS: Record<string, { capacity: number; doctors: number }> = {
          hospital: { capacity: 800, doctors: 200 },
          clinic:   { capacity: 234, doctors: 46 },
          dentist:  { capacity: 28,  doctors: 18 },
        };
        let boundsScore = 0;
        if (facility_type_id && TYPE_BOUNDS[facility_type_id] && doctorsPresent && capacityPresent) {
          const bounds = TYPE_BOUNDS[facility_type_id];
          if (capacityNum! <= bounds.capacity && doctorsNum! <= bounds.doctors) {
            boundsScore = 2;
          } else {
            flags.push(`Numeric values exceed p95 bounds for ${facility_type_id}: capacity=${capacityNum} (max ${bounds.capacity}), doctors=${doctorsNum} (max ${bounds.doctors}).`);
          }
        }

        // 6b: facilityTypeId vocabulary compliance (0–2)
        let facilityTypeScore = 0;
        if (facility_type_id === null || facility_type_id === undefined) {
          facilityTypeScore = 0;
        } else if (VALID_FACILITY_TYPES.has(facility_type_id)) {
          facilityTypeScore = 2;
        } else {
          facilityTypeScore = 1;
          flags.push(`facilityTypeId "${facility_type_id}" is not in the canonical set: hospital, clinic, dentist, pharmacy, nursing_home.`);
        }

        // 6c: operatorTypeId vocabulary compliance (0–2)
        let operatorTypeScore = 0;
        if (operator_type_id === null || operator_type_id === undefined) {
          operatorTypeScore = 0;
        } else if (VALID_OPERATOR_TYPES.has(operator_type_id)) {
          operatorTypeScore = 2;
        } else if (operator_type_id === 'government') {
          operatorTypeScore = 1;
          flags.push('operatorTypeId "government" is a synonym for "public" — flag for normalisation.');
        } else {
          operatorTypeScore = 1;
          flags.push(`operatorTypeId "${operator_type_id}" is not in the canonical set: private, public.`);
        }

        const classificationScore = boundsScore + facilityTypeScore + operatorTypeScore;

        // ── Total ─────────────────────────────────────────────────────────────
        const contextScore = Math.min(20,
          operationalCoverageScore +
          descriptionNameScore +
          specialtyConsistencyScore +
          numericPresenceScore +
          ratioScore +
          classificationScore
        );

        const grade =
          contextScore >= 17 ? 'Strong' :
          contextScore >= 12 ? 'Good' :
          contextScore >= 7  ? 'Moderate' :
          contextScore >= 3  ? 'Weak' : 'Poor';

        // Additional flag triggers from doc
        if (ratioScore === 0 && numericPresenceScore === 4) {
          // Already flagged above
        }
        if (classificationScore <= 2) {
          flags.push('Classification validity score ≤ 2 — type-aware bounds fail or classification fields are NULL/out-of-vocabulary.');
        }
        if (contextScore <= 2) {
          flags.push('context_score ≤ 2 — treat as untrustworthy until enriched.');
        }

        if (flags.length === 0) {
          flags.push('No consistency issues detected.');
        }

        if (runId) emitAgentDone(runId, 'context-validator');
        return {
          agent: 'context-validator',
          context_score: contextScore,
          grade,
          operational_coverage_score: operationalCoverageScore,
          description_name_score: descriptionNameScore,
          specialty_consistency_score: specialtyConsistencyScore,
          numeric_presence_score: numericPresenceScore,
          ratio_score: ratioScore,
          classification_score: classificationScore,
          bounds_score: boundsScore,
          facility_type_score: facilityTypeScore,
          operator_type_score: operatorTypeScore,
          anchor_word: anchorWord || null,
          flags,
        };
      },
    }),
  },
});
