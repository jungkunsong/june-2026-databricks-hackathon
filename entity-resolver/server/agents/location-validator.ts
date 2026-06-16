import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Location Validator agent.
 *
 * Tools:
 *
 * 1. lookup_pincode — fetches real post office data from api.postalpincode.in
 *    for a given Indian pincode. Returns the district, state, and the computed
 *    centroid (mean lat/lon of all post offices in that pincode). This replaces
 *    the previous approach of asking the model to supply the centroid from
 *    training knowledge, which was unreliable.
 *
 * 2. geocode_address — forward-geocodes a free-text address string via the
 *    Nominatim OpenStreetMap API. Returns the best-match lat/lon, display name,
 *    and bounding box. The agent uses this to compare the geocoded position
 *    against the facility's stored coordinates and flag discrepancies.
 *
 * 3. validate_location — pure Haversine math. Given a postcode centroid
 *    (now fetched by lookup_pincode rather than guessed), computes the distance
 *    between the facility's stored coordinates and the centroid and classifies:
 *      MATCH             — ≤ 20 km
 *      CLOSE             — 21–50 km
 *      MISMATCH          — > 50 km
 *      PINCODE_NOT_FOUND — pincode absent from the India Post directory
 *      MISSING_DATA      — postcode / lat / lon is null
 *
 * Recommended call sequence:
 *   1. lookup_pincode(postcode)          → get real centroid lat/lon + state/district
 *   2. geocode_address(full address)     → get geocoded lat/lon for cross-check
 *   3. validate_location(...)            → compute final MATCH/MISMATCH verdict
 */

// ── Haversine helper ──────────────────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export const locationValidatorAgent = createAgent({
  name: 'location-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Location Validator sub-agent.',
    'Your job is to verify that a facility\'s stored address, pincode, and lat/lon coordinates are consistent with each other.',
    '',
    'RECOMMENDED SEQUENCE:',
    '1. Call lookup_pincode with the facility\'s postcode to get the real district, state, and centroid coordinates from the India Post directory.',
    '2. Call geocode_address with the full address string (name + city + state + postcode) to get an independent geocoded lat/lon.',
    '3. Call validate_location with the stored lat/lon and the centroid from step 1 to get the final MATCH/MISMATCH verdict.',
    '4. Compare the geocoded lat/lon from step 2 against the stored lat/lon — flag if they differ by more than 30 km.',
    '',
    'If lookup_pincode returns INVALID or NOT_FOUND, still attempt geocode_address.',
    'If the facility has no postcode, skip step 1 and 3, only do step 2.',
    'If the facility has no address fields at all, return MISSING_DATA.',
    '',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"location-validator","status":"MATCH|CLOSE|MISMATCH|PINCODE_NOT_FOUND|GEOCODE_MISMATCH|MISSING_DATA","distance_km":<number or null>,"geocode_distance_km":<number or null>,"district":<string or null>,"state":<string or null>,"geocoded_address":<string or null>,"note":"<one sentence or null>"}',
  ].join('\n'),
  tools: {

    // ── Tool 1: India Post pincode lookup ─────────────────────────────────

    lookup_pincode: tool({
      description:
        'Looks up an Indian pincode in the India Post directory via api.postalpincode.in. ' +
        'Returns the district, state, and the computed centroid (mean lat/lon of all post offices ' +
        'in that pincode). Use this BEFORE calling validate_location so you have real centroid ' +
        'data instead of relying on model knowledge.',
      schema: z.object({
        postcode: z
          .string()
          .describe('The raw postcode value from the facility record (digits only, spaces/hyphens are stripped).'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ postcode }) => {
        const normalised = postcode.replace(/\D/g, '');

        if (normalised.length !== 6) {
          return {
            status: 'INVALID' as const,
            postcode: normalised,
            message: `Pincode must be exactly 6 digits — got "${normalised}" (${normalised.length} digits).`,
            district: null,
            state: null,
            centroid_lat: null,
            centroid_lon: null,
            post_office_count: 0,
          };
        }

        try {
          const res = await fetch(
            `https://api.postalpincode.in/pincode/${normalised}`,
            {
              headers: { 'User-Agent': 'entity-resolver/1.0 (hackathon; contact: sawyer@enrollhere.com)' },
              signal: AbortSignal.timeout(8_000),
            },
          );

          if (!res.ok) {
            return {
              status: 'API_ERROR' as const,
              postcode: normalised,
              message: `India Post API returned HTTP ${res.status}.`,
              district: null,
              state: null,
              centroid_lat: null,
              centroid_lon: null,
              post_office_count: 0,
            };
          }

          // Response shape: [{ Status: "Success"|"Error", PostOffice: [...] }]
          const data = await res.json() as Array<{
            Status: string;
            Message?: string;
            PostOffice: Array<{
              Name: string;
              District: string;
              State: string;
              Latitude?: string;
              Longitude?: string;
            }> | null;
          }>;

          const entry = data[0];
          if (!entry || entry.Status !== 'Success' || !entry.PostOffice?.length) {
            return {
              status: 'NOT_FOUND' as const,
              postcode: normalised,
              message: entry?.Message ?? 'Pincode not found in India Post directory.',
              district: null,
              state: null,
              centroid_lat: null,
              centroid_lon: null,
              post_office_count: 0,
            };
          }

          const offices = entry.PostOffice;
          const district = offices[0].District;
          const state = offices[0].State;

          // Compute centroid from offices that have valid coordinates
          const withCoords = offices.filter(
            (o) => o.Latitude && o.Longitude &&
              o.Latitude !== 'NA' && o.Longitude !== 'NA' &&
              !isNaN(parseFloat(o.Latitude)) && !isNaN(parseFloat(o.Longitude)),
          );

          let centroid_lat: number | null = null;
          let centroid_lon: number | null = null;

          if (withCoords.length > 0) {
            centroid_lat = Math.round(
              (withCoords.reduce((s, o) => s + parseFloat(o.Latitude!), 0) / withCoords.length) * 1e6,
            ) / 1e6;
            centroid_lon = Math.round(
              (withCoords.reduce((s, o) => s + parseFloat(o.Longitude!), 0) / withCoords.length) * 1e6,
            ) / 1e6;
          }

          return {
            status: 'FOUND' as const,
            postcode: normalised,
            district,
            state,
            centroid_lat,
            centroid_lon,
            post_office_count: offices.length,
            coords_available: withCoords.length,
            message: centroid_lat
              ? `Found ${offices.length} post offices in ${district}, ${state}. Centroid: ${centroid_lat}, ${centroid_lon}.`
              : `Found ${offices.length} post offices in ${district}, ${state} but none have coordinate data.`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'API_ERROR' as const,
            postcode: normalised,
            message: `Failed to reach India Post API: ${msg}`,
            district: null,
            state: null,
            centroid_lat: null,
            centroid_lon: null,
            post_office_count: 0,
          };
        }
      },
    }),

    // ── Tool 2: Nominatim forward geocoder ────────────────────────────────

    geocode_address: tool({
      description:
        'Forward-geocodes a free-text address string using the Nominatim OpenStreetMap API. ' +
        'Returns the best-match lat/lon, a human-readable display name, and the match type. ' +
        'Use this to independently verify that the facility\'s stored coordinates match where ' +
        'its address actually is. Compare the returned lat/lon against the stored lat/lon and ' +
        'flag discrepancies > 30 km.',
      schema: z.object({
        address: z
          .string()
          .describe(
            'Free-text address to geocode. Include as much detail as possible: ' +
            'facility name, street, city, state, postcode, country. ' +
            'Example: "Netrajyoti Eye Hospital, Guwahati, Assam, 781001, India"',
          ),
        country_code: z
          .string()
          .default('in')
          .describe('ISO 3166-1 alpha-2 country code to bias results. Defaults to "in" (India).'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ address, country_code }) => {
        try {
          const params = new URLSearchParams({
            q: address,
            format: 'json',
            limit: '3',
            countrycodes: country_code ?? 'in',
            addressdetails: '1',
          });

          const res = await fetch(
            `https://nominatim.openstreetmap.org/search?${params}`,
            {
              headers: {
                'User-Agent': 'entity-resolver/1.0 (hackathon; contact: sawyer@enrollhere.com)',
                'Accept-Language': 'en',
              },
              signal: AbortSignal.timeout(8_000),
            },
          );

          if (!res.ok) {
            return {
              status: 'API_ERROR' as const,
              query: address,
              message: `Nominatim returned HTTP ${res.status}.`,
              results: [],
            };
          }

          const results = await res.json() as Array<{
            lat: string;
            lon: string;
            display_name: string;
            type: string;
            importance: number;
            address: Record<string, string>;
          }>;

          if (!results.length) {
            return {
              status: 'NO_RESULTS' as const,
              query: address,
              message: 'No geocoding results found for this address.',
              results: [],
            };
          }

          const best = results[0];
          const geocoded_lat = parseFloat(best.lat);
          const geocoded_lon = parseFloat(best.lon);

          return {
            status: 'FOUND' as const,
            query: address,
            geocoded_lat: Math.round(geocoded_lat * 1e6) / 1e6,
            geocoded_lon: Math.round(geocoded_lon * 1e6) / 1e6,
            display_name: best.display_name,
            match_type: best.type,
            importance: Math.round(best.importance * 100) / 100,
            // Parsed address components for cross-checking
            addr_city: best.address?.city ?? best.address?.town ?? best.address?.village ?? null,
            addr_state: best.address?.state ?? null,
            addr_postcode: best.address?.postcode ?? null,
            addr_country: best.address?.country ?? null,
            // Top 3 candidates for transparency
            candidates: results.slice(0, 3).map((r) => ({
              lat: parseFloat(r.lat),
              lon: parseFloat(r.lon),
              display_name: r.display_name,
              type: r.type,
            })),
            message: `Best match: "${best.display_name}" at (${geocoded_lat.toFixed(4)}, ${geocoded_lon.toFixed(4)}).`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'API_ERROR' as const,
            query: address,
            message: `Failed to reach Nominatim API: ${msg}`,
            results: [],
          };
        }
      },
    }),

    // ── Tool 3: Haversine distance classifier (unchanged logic) ───────────

    validate_location: tool({
      description:
        'Cross-validates a facility\'s stored lat/lon coordinates against a pincode centroid ' +
        '(obtained from lookup_pincode). Returns MATCH, CLOSE, MISMATCH, PINCODE_NOT_FOUND, ' +
        'or MISSING_DATA. Call lookup_pincode first to get the real centroid — do not guess it.',
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
          .describe('Centroid latitude from lookup_pincode. Pass null if not found.'),
        pincode_centroid_lon: z
          .number()
          .nullable()
          .describe('Centroid longitude from lookup_pincode. Pass null if not found.'),
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

        const normPostcode = postcode.replace(/\D/g, '');

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
            notes: 'Pincode not found in India Post directory — cannot validate coordinates.',
          };
        }

        const distanceKm = haversineKm(latitude, longitude, pincode_centroid_lat, pincode_centroid_lon);
        const distanceRounded = Math.round(distanceKm * 10) / 10;

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
