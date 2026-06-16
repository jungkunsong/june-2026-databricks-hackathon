# Source Authority Validation

> **Agent:** `SourceAuthorityAgent`
> **Rubric role:** The SQL below is for data retrieval only. Tier classification and scoring are applied by the agent after fetching the domains. The listed domains are **examples, not an exhaustive allowlist** — the agent must classify any unlisted domain by reasoning about its nature rather than defaulting to Tier 6. See [Agent Judgment Guidelines](#agent-judgment-guidelines).

Scores each facility's `source_urls` array by the authority of the domains it references, producing a **domain authority score (0–20)** that reflects how well-evidenced the facility record is.

When a facility has multiple source URLs, the score is the **highest tier weight among all URLs** — i.e. a facility is only as authoritative as its best source. A single Wikipedia link outweighs ten JustDial entries.

## Approach

The agent fetches all URLs from `source_urls`, extracts each domain, classifies it into a tier, and takes the highest tier weight as the score. For any domain not in the explicit example lists, the agent classifies it by reasoning about the domain's purpose before assigning a tier.

### Domain Tier Classification

Tiers are derived from the actual domain distribution in `workspace.default.facilities` (top 50 domains by facility coverage, June 2026). The listed domains are **examples per tier, not an exhaustive allowlist**.

| Tier | Anchor score | Criteria | Example domains from dataset |
|---|---|---|---|
| **1 — Authoritative** | 20 | Government, academic, or globally recognised health bodies | `*.gov`, `*.gov.in`, `who.int`, `en.wikipedia.org`, `pmc.ncbi.nlm.nih.gov`, `pubmed.ncbi.nlm.nih.gov` |
| **2 — Professional / Official** | 16 | The facility's own domain, or verified professional networks | `in.linkedin.com`, facility-owned domains (matched against `officialWebsite`) |
| **3 — Healthcare directories** | 12 | Established healthcare listing or information platforms | `www.practo.com`, `www.lybrate.com`, `www.medindia.net`, `www.hexahealth.com`, `www.myupchar.com`, `www.docindia.org`, `www.medicineindia.org`, `www.clinicspots.com`, `www.bajajfinservhealth.in`, `www.healthfrog.in`, `www.drlogy.com`, `www.sehat.com`, `www.skedoc.com`, `www.eka.care`, `www.whatclinic.com` |
| **4 — General directories / aggregators** | 8 | High-traffic local business directories, insurance portals, map services | `www.justdial.com`, `www.indiamart.com`, `dir.indiamart.com`, `www.sulekha.com`, `www.grotal.com`, `www.mappls.com`, `mapcarta.com`, `www.latlong.net`, `www.zoominfo.com`, `www.zaubacorp.com`, `www.joonsquare.com`, `bdir.in`, `www.diagnosticcentres.in`, `www.cardiologistindia.com`, `www.healthinsuranceindia.org`, `www.policybazaar.com`, `www.policyx.com`, `www.insurancedekho.com`, `www.iffcotokio.co.in`, `www.newindia.co.in`, `www.cashlesshospitalindia.com`, `chotu.com`, `watchdoq.com`, `kivihealth.com`, `www.scribd.com` |
| **5 — Social media** | 4 | Social platforms — confirms online presence but low evidential value | `www.facebook.com`, `www.instagram.com`, `twitter.com`, `x.com`, `www.youtube.com` |
| **6 — Irrelevant / noise** | 0 | Domains with no plausible connection to healthcare facility evidence | Real-estate portals, unrelated e-commerce, clearly misrouted pipeline data |

> **Note on `www.proptiger.com`:** A real-estate portal appearing in ~1,141 facility records. Treat as Tier 6 — its presence at scale indicates a data pipeline issue, not a legitimate source.

### Scoring Formula

```
domain_authority_score = MAX(tier_score) across all URLs in source_urls
```

The score is a continuous **0–20** value. The tier anchor scores (20, 16, 12, 8, 4, 0) are calibrated reference points — the agent may assign any integer in that range when a domain sits between tiers or when additional context warrants it. For example, a healthcare directory that is clearly lower-quality than Practo but not as generic as JustDial might score 10 rather than 12 or 8.

| Anchor | Tier |
|---|---|
| 20 | Best source is Authoritative (gov, WHO, Wikipedia, PubMed) |
| 16 | Best source is Professional / Official (LinkedIn, own website) |
| 12 | Best source is a Healthcare directory |
| 8 | Best source is a General directory / aggregator |
| 4 | Best source is Social media only |
| 0 | All sources are irrelevant / noise |

A facility with a Wikipedia link and ten JustDial links scores **20**, not 28.

---

## Agent Judgment Guidelines

The SQL tier classification covers known domains. For anything not listed, the agent must reason about the domain rather than defaulting to Tier 6:

1. **Check TLD and domain name for structural signals first:** `.gov`, `.gov.in`, `.ac.in`, `.nhs.uk`, `.edu` → Tier 1. A domain matching `officialWebsite` for this facility → Tier 2. A domain whose name clearly identifies it as a healthcare listing platform → Tier 3.

2. **Assess the domain's apparent purpose:** Does it exist to list or verify healthcare facilities? → Tier 3. Does it list all kinds of local businesses? → Tier 4. Is it a news or media outlet that published an article about this facility? → Tier 3 (editorial mention has similar evidential value to a directory listing). Is it a map or location service? → Tier 4. Is it a social platform? → Tier 5. Is it completely unrelated to healthcare, business listings, or location? → Tier 6.

3. **Tier 6 is reserved for actively irrelevant domains**, not for domains that are simply unfamiliar. An unknown domain that plausibly references the facility should receive at minimum Tier 4 (8 pts).

4. **Scores are continuous (0–20), not locked to tier anchors.** The anchor scores (20, 16, 12, 8, 4, 0) are calibrated starting points. The agent may assign any integer when a domain sits between tiers or when context warrants it — for example, a niche healthcare directory that is less established than Practo might score 10, or a government-adjacent but non-authoritative source might score 18.

5. **Log every unlisted domain** and the assigned score in the rationale field so the supervisory agent can update the tier list over time.

**Examples of agent judgment calls:**
- `www.apollohospitals.com` — major hospital chain's own domain, matches `officialWebsite` pattern → Tier 2 (16 pts)
- `timesofindia.indiatimes.com` — news site with an article about this facility → Tier 3 (12 pts)
- `maps.google.com` — map/location service, same nature as `www.mappls.com` → Tier 4 (8 pts)
- `www.nhp.gov.in` — Indian government health portal, matches `*.gov.in` → Tier 1 (20 pts)
- `www.amazon.in` — e-commerce, no healthcare relevance → Tier 6 (0 pts)
- `www.proptiger.com` — real-estate portal → Tier 6 (0 pts), flag as pipeline issue
- `www.smallhealthblog.in` — obscure health blog, not a directory but loosely relevant → between Tier 4 and 5, agent assigns 6

---

## SQL — Data Retrieval

The agent uses this query to fetch raw domain data. Tier classification and scoring happen in the agent after retrieval, not inside the SQL.

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
)

SELECT
  unique_id,
  name,
  officialWebsite,
  domain,
  url,
  COUNT(*) OVER (PARTITION BY unique_id) AS url_count
FROM domains
ORDER BY unique_id, domain
```

> The agent receives this result set, classifies each domain into a tier using the criteria and judgment guidelines above, and computes `MAX(tier_weight)` as the final `domain_authority_score`.

---

## Score Interpretation

Scores are continuous 0–20. The bands below use the tier anchors as boundaries but a facility can score any value within a band.

| Score range | Label | Meaning |
|---|---|---|
| 17–20 | Strong | At least one government, academic, or globally recognised health source |
| 13–16 | Good | Best source is the facility's own website or a professional network |
| 9–12 | Moderate | Best source is an established healthcare directory |
| 5–8 | Weak | Best source is a general business directory, aggregator, or map service |
| 1–4 | Poor | Only social media presence; no independent verification |
| 0 | None | All sources are irrelevant or noise domains |

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
