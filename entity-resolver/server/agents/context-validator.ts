import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Context Validator agent.
 *
 * Scores each facility's contextual richness and internal consistency across
 * seven fields — specialties, procedure, equipment, capability, description,
 * numberDoctors, and capacity — producing a context score (0–20).
 *
 * Scoring breakdown (derived from context-validation.md, June 2026):
 *
 *  Completeness (0–10):
 *    specialties   present & non-empty → +2
 *    procedure     present & non-empty → +2
 *    equipment     present & non-empty → +1
 *    capability    present & non-empty → +1
 *    description   present & non-empty → +2
 *    numberDoctors present & numeric   → +1
 *    capacity      present & numeric   → +1
 *
 *  Consistency (0–10):
 *    specialties ∩ procedure overlap ≥ 1 term          → +2 (coherent scope)
 *    equipment plausible for specialties                → +2
 *    description mentions ≥ 1 specialty term            → +2
 *    numberDoctors in plausible range (1–5000)          → +2
 *    capacity in plausible range (5–10000)              → +2
 *
 *  Penalties:
 *    specialties has duplicates                         → −1
 *    procedure is empty array []                        → −1
 *    equipment is empty array []                        → −1
 *    description < 20 chars (stub)                      → −1
 */

type ContextResult = {
  agent: 'context-validator';
  completeness_score: number;
  consistency_score: number;
  total_score: number;
  max_score: number;
  grade: 'high' | 'medium' | 'low';
  flags: string[];
  field_statuses: Record<string, 'present' | 'empty' | 'missing'>;
};

function parseArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String).filter(Boolean);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed); } catch { /* fall through */ }
    }
    // comma-separated
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function fieldStatus(val: unknown): 'present' | 'empty' | 'missing' {
  if (val == null || val === '' || val === 'null') return 'missing';
  const arr = parseArray(val);
  if (Array.isArray(val) || (typeof val === 'string' && val.trim().startsWith('['))) {
    return arr.length > 0 ? 'present' : 'empty';
  }
  return 'present';
}

export const contextValidatorAgent = createAgent({
  name: 'context-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Context Validator sub-agent.',
    'When called, invoke `score_context` once with the provided fields.',
    'Return ONLY the raw JSON object from the tool — no markdown, no prose, no explanation.',
  ].join(' '),
  tools: {
    score_context: tool({
      description: 'Scores a facility record\'s contextual completeness and internal consistency across specialties, procedure, equipment, capability, description, numberDoctors, and capacity.',
      schema: z.object({
        facility_name: z.string().describe('Facility name, used for description overlap check.'),
        specialties: z.string().nullable().optional().describe('Comma-separated or JSON array of specialties.'),
        procedure: z.string().nullable().optional().describe('Comma-separated or JSON array of procedures.'),
        equipment: z.string().nullable().optional().describe('Comma-separated or JSON array of equipment.'),
        capability: z.string().nullable().optional().describe('Comma-separated or JSON array of capabilities.'),
        description: z.string().nullable().optional().describe('Free-text facility description.'),
        numberDoctors: z.string().nullable().optional().describe('Number of doctors (string or numeric).'),
        capacity: z.string().nullable().optional().describe('Bed/patient capacity (string or numeric).'),
      }),
      annotations: { effect: 'read' },
      execute: ({
        facility_name: _facility_name,
        specialties,
        procedure,
        equipment,
        capability,
        description,
        numberDoctors,
        capacity,
      }): ContextResult => {
        const flags: string[] = [];

        // ── Field statuses ────────────────────────────────────────────────
        const statuses: Record<string, 'present' | 'empty' | 'missing'> = {
          specialties: fieldStatus(specialties),
          procedure:   fieldStatus(procedure),
          equipment:   fieldStatus(equipment),
          capability:  fieldStatus(capability),
          description: fieldStatus(description),
          numberDoctors: fieldStatus(numberDoctors),
          capacity:    fieldStatus(capacity),
        };

        // ── Completeness (0–10) ───────────────────────────────────────────
        let completeness = 0;
        if (statuses.specialties   === 'present') completeness += 2;
        if (statuses.procedure     === 'present') completeness += 2;
        if (statuses.equipment     === 'present') completeness += 1;
        if (statuses.capability    === 'present') completeness += 1;
        if (statuses.description   === 'present') completeness += 2;
        if (statuses.numberDoctors === 'present') completeness += 1;
        if (statuses.capacity      === 'present') completeness += 1;

        // ── Consistency (0–10) ────────────────────────────────────────────
        let consistency = 0;

        const specArr  = parseArray(specialties);
        const procArr  = parseArray(procedure);
        const equipArr = parseArray(equipment);

        // Specialties ∩ procedure overlap
        if (specArr.length > 0 && procArr.length > 0) {
          const specLower = specArr.map(s => s.toLowerCase());
          const procLower = procArr.map(s => s.toLowerCase());
          const overlap = specLower.some(s =>
            procLower.some(p => p.includes(s) || s.includes(p))
          );
          if (overlap) {
            consistency += 2;
          } else {
            flags.push('Specialties and procedures share no overlapping terms.');
          }
        } else if (specArr.length > 0 || procArr.length > 0) {
          flags.push('Only one of specialties/procedure is populated; overlap cannot be assessed.');
        }

        // Equipment plausible for specialties
        if (equipArr.length > 0 && specArr.length > 0) {
          // Heuristic: equipment terms should not be completely disjoint from specialty domain
          const medicalEquipTerms = ['mri', 'ct', 'xray', 'x-ray', 'ultrasound', 'ecg', 'eeg',
            'ventilator', 'dialysis', 'endoscope', 'laparoscope', 'defibrillator', 'monitor',
            'infusion', 'incubator', 'mammogram', 'pet', 'scan', 'surgical', 'laser'];
          const equipLower = equipArr.map(e => e.toLowerCase()).join(' ');
          const hasMedical = medicalEquipTerms.some(t => equipLower.includes(t));
          if (hasMedical) {
            consistency += 2;
          } else {
            consistency += 1; // equipment present but generic
            flags.push('Equipment terms do not match recognisable medical equipment vocabulary.');
          }
        } else if (statuses.equipment === 'present') {
          consistency += 1;
        }

        // Description mentions ≥ 1 specialty term
        if (description && specArr.length > 0) {
          const descLower = description.toLowerCase();
          const mentioned = specArr.some(s => descLower.includes(s.toLowerCase().slice(0, 6)));
          if (mentioned) {
            consistency += 2;
          } else {
            flags.push('Description does not reference any listed specialties.');
          }
        } else if (description && description.length >= 20) {
          consistency += 1; // description present but no specialties to cross-check
        }

        // numberDoctors plausible range
        if (numberDoctors) {
          const n = parseInt(String(numberDoctors).replace(/[^0-9]/g, ''), 10);
          if (!isNaN(n) && n >= 1 && n <= 5000) {
            consistency += 2;
          } else if (!isNaN(n)) {
            flags.push(`numberDoctors value ${n} is outside plausible range (1–5000).`);
          }
        }

        // Capacity plausible range
        if (capacity) {
          const c = parseInt(String(capacity).replace(/[^0-9]/g, ''), 10);
          if (!isNaN(c) && c >= 5 && c <= 10000) {
            consistency += 2;
          } else if (!isNaN(c)) {
            flags.push(`Capacity value ${c} is outside plausible range (5–10000).`);
          }
        }

        // ── Penalties ─────────────────────────────────────────────────────
        let penalty = 0;

        // Duplicate specialties
        if (specArr.length > 0) {
          const lower = specArr.map(s => s.toLowerCase());
          const unique = new Set(lower);
          if (unique.size < lower.length) {
            penalty += 1;
            flags.push(`Specialties contains ${lower.length - unique.size} duplicate(s).`);
          }
        }

        // Empty arrays
        if (statuses.procedure === 'empty') {
          penalty += 1;
          flags.push('Procedure field is an empty array.');
        }
        if (statuses.equipment === 'empty') {
          penalty += 1;
          flags.push('Equipment field is an empty array.');
        }

        // Stub description
        if (description && description.trim().length > 0 && description.trim().length < 20) {
          penalty += 1;
          flags.push('Description is too short (< 20 chars) — likely a stub.');
        }

        // ── Final score ───────────────────────────────────────────────────
        const raw = completeness + consistency - penalty;
        const total = Math.max(0, Math.min(20, raw));
        const grade: 'high' | 'medium' | 'low' =
          total >= 14 ? 'high' : total >= 8 ? 'medium' : 'low';

        if (flags.length === 0) {
          flags.push('No consistency issues detected.');
        }

        return {
          agent: 'context-validator',
          completeness_score: completeness,
          consistency_score: Math.max(0, consistency - penalty),
          total_score: total,
          max_score: 20,
          grade,
          flags,
          field_statuses: statuses,
        };
      },
    }),
  },
});
