import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Duplicate Detector agent.
 *
 * Scans the facilities table for records that are likely the same real-world
 * entity as the target row. Distinct from data-quality validators — this agent
 * answers: "Does another record exist that should be merged with this one?"
 *
 * Signal hierarchy (strongest → weakest):
 *   1. Shared phone number across different unique_ids         → strong merge signal
 *   2. Shared officialWebsite / websites domain               → strong merge signal
 *   3. Shared facebookLink                                    → strong merge signal
 *   4. Coordinates within ~0.5 km + similar name             → likely merge signal
 *   5. Same postcode + fuzzy name match                       → possible merge signal
 *
 * Known data quality pre-corrections applied before comparison:
 *   - Literal "null" strings treated as NULL
 *   - City/state name normalisation (e.g. "farmacy" → ignore, non-standard spellings)
 *   - The 11 known exact-duplicate groups (identical rows, different unique_id) will
 *     surface naturally via shared phone/website/coordinate signals
 *
 * Merge recommendation thresholds:
 *   definite  — 2+ strong signals fire (phone + website, phone + facebook, etc.)
 *   likely    — 1 strong signal + coordinate proximity OR name similarity ≥ 80%
 *   possible  — 1 strong signal alone, OR coordinate proximity + name similarity ≥ 60%
 *   none      — no signals fire
 */
export const duplicateDetectorAgent = createAgent({
  name: 'duplicate-detector',
  model: 'OpenAI',
  instructions: [
    'You are the Duplicate Detector sub-agent.',
    'When given a row_id, call `find_duplicate_candidates` once.',
    'The tool queries the database for records sharing phone, website, facebook, or coordinates with the target.',
    'For each candidate returned, compute a similarity_score (0–100) and merge_recommendation.',
    'Use name similarity as a tiebreaker: if two records share a phone but have completely different names,',
    'downgrade from "definite" to "likely". If they share coordinates but names differ by > 50%, downgrade to "possible".',
    'Normalise names before comparing: lowercase, strip punctuation, collapse whitespace.',
    'Treat literal "null" strings as missing data — do not treat them as matching values.',
    'Return ONLY a compact JSON object — no markdown, no prose:',
    '{"agent":"duplicate-detector","row_id":"<row_id>","candidates":[{"candidate_row_id":<n>,"candidate_name":"<name>","similarity_score":<0-100>,"merge_recommendation":"definite|likely|possible|none","signals":["<signal1>","<signal2>"]}],"total_candidates":<n>}',
    'If no candidates are found, return candidates as an empty array and total_candidates as 0.',
  ].join(' '),
  tools: {
    find_duplicate_candidates: tool({
      description:
        'Queries the facilities database for records that share at least one strong identity signal (phone, website, facebook link, or coordinates within ~0.5 km) with the target row. Returns the target record and up to 20 candidates with their raw field values for the agent to score.',
      schema: z.object({
        row_id: z.number().describe('The row_id of the target facility record to find duplicates for.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ row_id }) => {
        try {
          const base = `http://localhost:${process.env.DATABRICKS_APP_PORT ?? 8000}`;
          const res = await fetch(`${base}/api/facilities/duplicate-candidates/${row_id}`);
          if (!res.ok) {
            return { error: `HTTP ${res.status}: ${res.statusText}`, row_id };
          }
          const data = await res.json() as {
            target_row_id: number;
            target?: Record<string, unknown>;
            candidates: Array<Record<string, unknown>>;
          };

          // Normalise helper — treat literal "null" strings as null
          const norm = (v: unknown): string | null => {
            if (!v) return null;
            const s = String(v).trim();
            return s === '' || s.toLowerCase() === 'null' ? null : s;
          };

          // Annotate each candidate with which signals fired
          const target = data.target ?? {};
          const annotated = (data.candidates ?? []).map((c) => {
            const signals: string[] = [];

            const tPhone   = norm(target.phone_numbers);
            const tWebsite = norm(target.websites);
            const tFb      = norm(target['facebookLink']);
            const tLat     = target.latitude != null ? parseFloat(String(target.latitude)) : null;
            const tLng     = target.longitude != null ? parseFloat(String(target.longitude)) : null;

            const cPhone   = norm(c.phone_numbers);
            const cWebsite = norm(c.websites);
            const cFb      = norm(c['facebookLink']);
            const cLat     = c.latitude != null ? parseFloat(String(c.latitude)) : null;
            const cLng     = c.longitude != null ? parseFloat(String(c.longitude)) : null;

            if (tPhone && cPhone && tPhone === cPhone) signals.push('shared_phone');
            if (tWebsite && cWebsite && tWebsite === cWebsite) signals.push('shared_website');
            if (tFb && cFb && tFb === cFb) signals.push('shared_facebook');
            if (
              tLat !== null && tLng !== null && cLat !== null && cLng !== null
            ) {
              const dLat = Math.abs(tLat - cLat);
              const dLng = Math.abs(tLng - cLng);
              // ~0.5 km ≈ 0.0045 degrees
              if (dLat <= 0.0045 && dLng <= 0.0045) signals.push('coordinate_proximity');
            }

            const tZip = norm(target['address_zipOrPostcode']);
            const cZip = norm(c['address_zipOrPostcode']);
            if (tZip && cZip && tZip === cZip) signals.push('same_postcode');

            return {
              candidate_row_id: c.row_id,
              candidate_unique_id: c.unique_id,
              candidate_name: norm(c.name) ?? '(unknown)',
              target_name: norm(target.name) ?? '(unknown)',
              signals,
              raw: {
                phone:    cPhone,
                website:  cWebsite,
                facebook: cFb,
                lat:      cLat,
                lng:      cLng,
                zip:      cZip,
                city:     norm(c.address_city),
                state:    norm(c['address_stateOrRegion']),
              },
            };
          });

          return {
            row_id,
            target_name: norm(target.name) ?? '(unknown)',
            target_signals: {
              phone:    norm(target.phone_numbers),
              website:  norm(target.websites),
              facebook: norm(target['facebookLink']),
              lat:      target.latitude != null ? parseFloat(String(target.latitude)) : null,
              lng:      target.longitude != null ? parseFloat(String(target.longitude)) : null,
              zip:      norm(target['address_zipOrPostcode']),
            },
            candidate_count: annotated.length,
            candidates: annotated,
          };
        } catch (err) {
          return { error: String(err), row_id };
        }
      },
    }),
  },
});
