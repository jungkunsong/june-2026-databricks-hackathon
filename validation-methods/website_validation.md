# Website Validation Report

**Table:** `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`  
**Column:** `officialWebsite`  
**Date:** 2026-06-15  
**Method:** HTTP status check via `curl` with 5s timeout and 3s connect timeout

## Results

| # | Facility Name | officialWebsite | HTTP Status | Verdict |
|---|---|---|---|---|
| 1 | Aravind Eye Hospital | aravind.org | 200 | ✅ Verified |
| 2 | Fortis Hospital, Gurugram | fortishealthcare.com | 000 | ❌ Unreachable |
| 3 | Fortis Hospital Anandapur | tmckolkata.com | 302 | ⚠️ Redirects (likely valid) |
| 4 | Wockhardt Hospital Nagpur | fortishealthcare.com | 000 | ❌ Unreachable |
| 5 | RAM HOSPITAL & RESEARCH CENTRE, KANPUR | ramahospital.com | 200 | ✅ Verified |
| 6 | HCG Manavata Cancer Centre | manavatacancercentre.com | 409 | ⚠️ Domain exists, server misconfigured |
| 7 | Rajarajeswari Medical College and Hospital | rrmch.org | 301 | ⚠️ Redirects (likely valid) |
| 8 | Medanta The Medicity, Gurgaon | medanta.org | 301 | ⚠️ Redirects (likely valid) |
| 9 | Sumitra Hospital | sumitrahospital.com | 000 | ❌ Unreachable |
| 10 | Government Medical College, Thiruvananthapuram | jmmcri.org | 200 | ✅ Verified |

## Summary

| Verdict | Count |
|---|---|
| ✅ Verified (200) | 3 |
| ⚠️ Redirecting (301/302) | 3 |
| ⚠️ Conflict/Misconfigured (409) | 1 |
| ❌ Unreachable (000) | 3 |

## Data Quality Issues

- **Duplicate website across different hospital chains:** `fortishealthcare.com` is assigned to both *Fortis Hospital, Gurugram* and *Wockhardt Hospital Nagpur*. Wockhardt and Fortis are distinct hospital chains — this is likely a data entry error.
- **3 unreachable domains:** `fortishealthcare.com` (×2) and `sumitrahospital.com` returned HTTP 000, meaning the connection could not be established. These may be blocked, taken down, or incorrectly recorded.
