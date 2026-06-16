import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Location Validator agent.
 *
 * Cross-validates facility coordinates against the India Post Pincode
 * Directory. For each record that has address_zipOrPostcode, latitude, and
 * longitude populated, it computes the Haversine distance between the
 * facility's coordinates and the centroid of all post offices sharing that
 * pincode, then classifies the result:
 *
 *   MATCH             — ≤ 20 km   (coordinates consistent with postcode)
 *   CLOSE             — 21–50 km  (minor discrepancy, possible data entry issue)
 *   MISMATCH          — > 50 km   (coordinates and postcode point to different locations)
 *   PINCODE_NOT_FOUND — pincode absent from the directory
 *   MISSING_DATA      — one or more of postcode / lat / lon is null
 *
 * The pincode centroid is the arithmetic mean of all post office lat/lons
 * within that pincode. Postcode normalisation strips non-digit characters
 * before the lookup (e.g. "201 301" → 201301).
 */
export const locationValidatorAgent = createAgent({
  name: 'location-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Location Validator sub-agent.',
    'When given a location, call `validate_location` once.',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"location-validator","status":"MATCH|CLOSE|MISMATCH|PINCODE_NOT_FOUND|MISSING_DATA","distance_km":<number or null>,"note":"<one sentence or null>"}',
  ].join(' '),
  tools: {
    validate_location: tool({
      description:
        'Cross-validates a facility\'s lat/lon coordinates against the India Post Pincode Directory centroid for its postcode. Returns a classification of MATCH, CLOSE, MISMATCH, PINCODE_NOT_FOUND, or MISSING_DATA.',
      schema: z.object({
        record_id: z.string().describe('The unique_id of the facility record.'),
        facility_name: z.string().describe('The facility name from the database.'),
        postcode: z
          .string()
          .nullable()
          .describe('The address_zipOrPostcode value (may contain spaces or hyphens).'),
        latitude: z.number().nullable().describe('The facility latitude in decimal degrees.'),
        longitude: z.number().nullable().describe('The facility longitude in decimal degrees.'),
        pincode_centroid_lat: z
          .number()
          .nullable()
          .describe(
            'The average latitude of all post offices in the India Post directory for this pincode. Pass null if the pincode was not found.',
          ),
        pincode_centroid_lon: z
          .number()
          .nullable()
          .describe(
            'The average longitude of all post offices in the India Post directory for this pincode. Pass null if the pincode was not found.',
          ),
      }),
      annotations: { effect: 'read' },
      execute: ({
        record_id,
        facility_name,
        postcode,
        latitude,
        longitude,
        pincode_centroid_lat,
        pincode_centroid_lon,
      }) => {
        // ── Missing data guard ──────────────────────────────────────────────
        if (postcode === null || latitude === null || longitude === null) {
          return {
            record_id,
            facility_name,
            postcode,
            latitude,
            longitude,
            normalised_postcode: null,
            centroid_lat: null,
            centroid_lon: null,
            distance_km: null,
            validation_result: 'MISSING_DATA' as const,
            notes: 'One or more of postcode / latitude / longitude is null.',
          };
        }

        // ── Normalise postcode: strip non-digits ────────────────────────────
        const normPostcode = postcode.replace(/\D/g, '');

        // ── Pincode not in directory ────────────────────────────────────────
        if (pincode_centroid_lat === null || pincode_centroid_lon === null) {
          return {
            record_id,
            facility_name,
            postcode,
            latitude,
            longitude,
            normalised_postcode: normPostcode,
            centroid_lat: null,
            centroid_lon: null,
            distance_km: null,
            validation_result: 'PINCODE_NOT_FOUND' as const,
            notes: `Pincode "${normPostcode}" not found in the India Post directory.`,
          };
        }

        // ── Haversine distance (km) ─────────────────────────────────────────
        const R = 6371; // Earth radius in km
        const toRad = (deg: number) => (deg * Math.PI) / 180;

        const dLat = toRad(pincode_centroid_lat - latitude);
        const dLon = toRad(pincode_centroid_lon - longitude);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(latitude)) *
            Math.cos(toRad(pincode_centroid_lat)) *
            Math.sin(dLon / 2) ** 2;
        const distanceKm = 2 * R * Math.asin(Math.sqrt(a));
        const distanceRounded = Math.round(distanceKm * 10) / 10;

        // ── Classify ────────────────────────────────────────────────────────
        let validationResult: 'MATCH' | 'CLOSE' | 'MISMATCH';
        if (distanceKm <= 20) {
          validationResult = 'MATCH';
        } else if (distanceKm <= 50) {
          validationResult = 'CLOSE';
        } else {
          validationResult = 'MISMATCH';
        }

        return {
          record_id,
          facility_name,
          postcode,
          latitude,
          longitude,
          normalised_postcode: normPostcode,
          centroid_lat: pincode_centroid_lat,
          centroid_lon: pincode_centroid_lon,
          distance_km: distanceRounded,
          validation_result: validationResult,
          notes:
            validationResult === 'MATCH'
              ? null
              : validationResult === 'CLOSE'
                ? `${distanceRounded} km from pincode centroid — minor discrepancy, check neighbouring area.`
                : `${distanceRounded} km from pincode centroid — coordinates and postcode point to different locations.`,
        };
      },
    }),
  },
});
