# Source Authority Validation

Scores each facility's `source_urls` array by the authority of the domains it references, producing a **domain authority score** that reflects how well-evidenced the facility record is.

When a facility has multiple source URLs, the score is the **highest tier weight among all URLs** — i.e. a facility is only as authoritative as its best source. A single Wikipedia link outweighs ten JustDial entries.

## Approach

Each URL in `source_urls` is parsed to extract its domain, which is then mapped to a tier. The per-facility score is the **highest tier weight across all URLs** — the best source wins. This prevents a facility with many low-quality links from outscoring one with a single authoritative reference.

### Domain Tier Classification

Tiers are derived from the actual domain distribution in `workspace.default.facilities` (top 50 domains by facility coverage, June 2026).

| Tier | Weight | Criteria | Examples from dataset |
|---|---|---|---|
| **1 — Authoritative** | 5 | Government, academic, or globally recognised health bodies | `*.gov`, `*.gov.in`, `who.int`, `en.wikipedia.org`, `pmc.ncbi.nlm.nih.gov`, `pubmed.ncbi.nlm.nih.gov` |
| **2 — Professional / Official** | 4 | The facility's own domain, or verified professional networks | `in.linkedin.com`, facility-owned domains (matched against `officialWebsite`) |
| **3 — Healthcare directories** | 3 | Established India-specific healthcare listing platforms | `www.practo.com`, `www.lybrate.com`, `www.medindia.net`, `www.hexahealth.com`, `www.myupchar.com`, `www.docindia.org`, `www.medicineindia.org`, `www.clinicspots.com`, `www.bajajfinservhealth.in`, `www.healthfrog.in`, `www.drlogy.com`, `www.sehat.com`, `www.skedoc.com`, `www.eka.care`, `www.whatclinic.com` |
| **4 — General directories / aggregators** | 2 | High-traffic local business directories, insurance portals, map services | `www.justdial.com`, `www.indiamart.com`, `dir.indiamart.com`, `www.sulekha.com`, `www.grotal.com`, `www.mappls.com`, `mapcarta.com`, `www.latlong.net`, `www.zoominfo.com`, `www.zaubacorp.com`, `www.joonsquare.com`, `bdir.in`, `www.diagnosticcentres.in`, `www.cardiologistindia.com`, `www.healthinsuranceindia.org`, `www.policybazaar.com`, `www.policyx.com`, `www.insurancedekho.com`, `www.iffcotokio.co.in`, `www.newindia.co.in`, `www.cashlesshospitalindia.com`, `chotu.com`, `watchdoq.com`, `kivihealth.com`, `www.scribd.com` |
| **5 — Social media** | 1 | Social platforms — confirms online presence but low evidential value | `www.facebook.com`, `www.instagram.com` |
| **6 — Unknown** | 0 | Any domain not matching the above tiers | everything else |

> **Note on `www.proptiger.com`:** A real-estate portal appearing in ~1,141 facility records. Treat as Tier 6 (Unknown/irrelevant) — its presence likely indicates a data pipeline issue rather than a legitimate source.

### Scoring Formula

```
domain_authority_score = MAX(tier_weight) across all URLs in source_urls
```

The score is already on the tier weight scale (0–5), so no normalisation is needed. A facility with any Tier 1 URL scores 5 regardless of how many Tier 4/5 URLs it also has.

| Score | Tier |
|---|---|
| 5 | Best source is Authoritative (gov, WHO, Wikipedia, PubMed) |
| 4 | Best source is Professional / Official (LinkedIn, own website) |
| 3 | Best source is a Healthcare directory |
| 2 | Best source is a General directory / aggregator |
| 1 | Best source is Social media only |
| 0 | All sources are Unknown / irrelevant |

A facility with a Wikipedia link and ten JustDial links scores **5**, not 25.

---

## SQL Implementation

```sql
WITH urls AS (
  SELECT
    f.unique_id,
    f.name,
    f.officialWebsite,
    url
  FROM workspace.default.facilities f
  LATERAL VIEW explode(from_json(f.source_urls, 'array<string>')) t AS url
  WHERE f.source_urls IS NOT NULL AND url IS NOT NULL
),

domains AS (
  SELECT
    unique_id,
    name,
    officialWebsite,
    url,
    regexp_extract(url, '^https?://([^/]+)', 1) AS domain
  FROM urls
  WHERE url != ''
),

tiered AS (
  SELECT
    unique_id,
    name,
    domain,
    CASE
      -- Tier 1: Authoritative
      WHEN domain RLIKE '.*\\.gov(\\.in)?$'
        OR domain IN ('who.int', 'en.wikipedia.org', 'pmc.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov')
        THEN 5
      -- Tier 2: Professional / Official
      WHEN domain = 'in.linkedin.com'
        OR domain = regexp_extract(officialWebsite, '^https?://([^/]+)', 1)
        THEN 4
      -- Tier 3: Healthcare directories
      WHEN domain IN (
        'www.practo.com', 'www.lybrate.com', 'www.medindia.net', 'www.hexahealth.com',
        'www.myupchar.com', 'www.docindia.org', 'www.medicineindia.org', 'www.clinicspots.com',
        'www.bajajfinservhealth.in', 'www.healthfrog.in', 'www.drlogy.com', 'www.sehat.com',
        'www.skedoc.com', 'www.eka.care', 'www.whatclinic.com'
      ) THEN 3
      -- Tier 4: General directories / aggregators
      WHEN domain IN (
        'www.justdial.com', 'www.indiamart.com', 'dir.indiamart.com', 'www.sulekha.com',
        'www.grotal.com', 'www.mappls.com', 'mapcarta.com', 'www.latlong.net',
        'www.zoominfo.com', 'www.zaubacorp.com', 'www.joonsquare.com', 'bdir.in',
        'www.diagnosticcentres.in', 'www.cardiologistindia.com', 'www.healthinsuranceindia.org',
        'www.policybazaar.com', 'www.policyx.com', 'www.insurancedekho.com',
        'www.iffcotokio.co.in', 'www.newindia.co.in', 'www.cashlesshospitalindia.com',
        'chotu.com', 'watchdoq.com', 'kivihealth.com', 'www.scribd.com'
      ) THEN 2
      -- Tier 5: Social media
      WHEN domain IN ('www.facebook.com', 'www.instagram.com') THEN 1
      -- Tier 6: Unknown / irrelevant
      ELSE 0
    END AS tier_weight
  FROM domains
),

-- Best score: take the single highest tier weight across all URLs for this facility
scored AS (
  SELECT
    unique_id,
    name,
    MAX(tier_weight)                     AS domain_authority_score,
    COUNT(*)                             AS url_count,
    MAX(CASE WHEN tier_weight = 5 THEN domain END) AS best_tier1_domain,
    MAX(CASE WHEN tier_weight = 4 THEN domain END) AS best_tier2_domain,
    MAX(CASE WHEN tier_weight = 3 THEN domain END) AS best_tier3_domain
  FROM tiered
  GROUP BY unique_id, name
)

SELECT * FROM scored ORDER BY domain_authority_score DESC
```

---

## Score Interpretation

| Score | Label | Meaning |
|---|---|---|
| 5 | Strong | At least one government, academic, or globally recognised health source |
| 4 | Good | Best source is the facility's own website or a professional network |
| 3 | Moderate | Best source is an established healthcare directory |
| 2 | Weak | Best source is a general business directory or aggregator |
| 1 | Poor | Only social media presence; no independent verification |
| 0 | None | All sources are unknown or irrelevant domains |

---

## Flags

A facility should be flagged for review if any of the following are true:

- `domain_authority_score <= 1` — no source better than social media; record lacks independent verification
- `domain_authority_score = 0` — all URLs resolve to unknown/irrelevant domains
- `url_count >= 5 AND domain_authority_score <= 1` — many URLs but none from a credible source (possible link spam)

---

## Limitations

- **Tier list is static**: New domains entering the pipeline will default to Tier 6 (Unknown) until the list is updated. The agent should periodically re-examine the domain distribution and reclassify.
- **`officialWebsite` matching for Tier 2**: Domain extraction from `officialWebsite` may fail if the column contains bare domains (e.g. `aravind.org`) without a scheme. Normalise before comparing.
- **`www.proptiger.com`** appears in ~1,141 records — its presence at scale likely indicates a systematic pipeline issue. Treat as a separate data quality flag rather than a source authority signal.
- **Score does not validate liveness**: A high score means the sources are from reputable domains, not that the URLs are still live. Combine with `website_validation.md` for full coverage.
