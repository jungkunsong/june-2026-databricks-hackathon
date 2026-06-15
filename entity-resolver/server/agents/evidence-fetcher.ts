import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

// Fields that are purely internal / noisy — strip before sending to supervisor
const STRIP_FIELDS = new Set([
  'source_ids', 'source_types', 'source_content_id', 'content_table_id',
  'coordinates', 'source', 'cluster_id', 'recency_of_page_update',
  'distinct_social_media_presence_count', 'affiliated_staff_presence',
  'custom_logo_presence', 'engagement_metrics_n_followers',
  'engagement_metrics_n_likes', 'engagement_metrics_n_engagements',
  'post_metrics_most_recent_social_media_post_date', 'post_metrics_post_count',
]);

// Fields where we keep only unique values and cap the array length
const DEDUP_ARRAY_FIELDS = new Set([
  'phone_numbers', 'specialties', 'source_urls', 'websites',
  'procedure', 'equipment', 'capability', 'affiliationTypeIds',
]);

const MAX_ARRAY_ITEMS = 5;   // max items shown per array field
const MAX_STRING_LEN = 300;  // truncate long strings

function cleanRecord(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (STRIP_FIELDS.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;

    if (Array.isArray(v)) {
      if (DEDUP_ARRAY_FIELDS.has(k)) {
        // Deduplicate, remove empties, cap length
        const unique = [...new Set(v.filter((x) => x !== null && x !== '' && x !== undefined))];
        out[k] = unique.slice(0, MAX_ARRAY_ITEMS);
        if (unique.length > MAX_ARRAY_ITEMS) {
          (out[k] as unknown[]).push(`… and ${unique.length - MAX_ARRAY_ITEMS} more`);
        }
      } else {
        out[k] = v;
      }
    } else if (typeof v === 'string' && v.length > MAX_STRING_LEN) {
      out[k] = v.slice(0, MAX_STRING_LEN) + '…';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Evidence Fetcher agent.
 *
 * Returns a cleaned, deduplicated summary of the facility record.
 * Strips internal/noisy fields and caps long arrays so the supervisor
 * receives a concise brief rather than a data dump.
 */
export const evidenceFetcherAgent = createAgent({
  name: 'evidence-fetcher',
  model: 'OpenAI',
  instructions: [
    'You are the Evidence Fetcher sub-agent.',
    'When called, call `fetch_facility` with the given row_id.',
    'Return ONLY a compact JSON object — no markdown, no prose, no tables:',
    '{"name":"<name>","address":"<city>, <state> <zip>","officialPhone":"<phone or null>","officialWebsite":"<url or null>","facebookLink":"<url or null>","latitude":<num or null>,"longitude":<num or null>,"address_zipOrPostcode":"<zip or null>","facilityTypeId":"<type>","operatorTypeId":"<type>","specialties":"<comma-separated top 5 or null>","equipment":"<comma-separated top 3 or null>","missing":["<field names that are null>"]}',
  ].join(' '),
  tools: {
    fetch_facility: tool({
      description: 'Fetch and clean a single raw facility record by row_id.',
      schema: z.object({
        row_id: z.number().describe('The row_id of the facility record to fetch'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ row_id }) => {
        try {
          const res = await fetch(`http://localhost:${process.env.DATABRICKS_APP_PORT ?? 8000}/api/facilities/${row_id}`);
          if (!res.ok) {
            return { error: `HTTP ${res.status}: ${res.statusText}`, row_id };
          }
          const record = await res.json() as Record<string, unknown>;
          return { row_id, record: cleanRecord(record) };
        } catch (err) {
          return { error: String(err), row_id };
        }
      },
    }),
  },
});
