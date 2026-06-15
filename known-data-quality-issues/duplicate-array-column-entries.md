WITH cols AS (
    SELECT unique_id, explode(from_json(source_ids,         'array<string>')) AS val, 'source_ids'         AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE source_ids         IS NOT NULL AND source_ids         NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(source_types,       'array<string>')) AS val, 'source_types'       AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE source_types       IS NOT NULL AND source_types       NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(specialties,        'array<string>')) AS val, 'specialties'        AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE specialties        IS NOT NULL AND specialties        NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(phone_numbers,      'array<string>')) AS val, 'phone_numbers'      AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE phone_numbers      IS NOT NULL AND phone_numbers      NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(websites,           'array<string>')) AS val, 'websites'           AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE websites           IS NOT NULL AND websites           NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(procedure,          'array<string>')) AS val, 'procedure'          AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE procedure          IS NOT NULL AND procedure          NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(capability,         'array<string>')) AS val, 'capability'         AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE capability         IS NOT NULL AND capability         NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(source_urls,        'array<string>')) AS val, 'source_urls'        AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE source_urls        IS NOT NULL AND source_urls        NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(equipment,          'array<string>')) AS val, 'equipment'          AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE equipment          IS NOT NULL AND equipment          NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(affiliationTypeIds, 'array<string>')) AS val, 'affiliationTypeIds' AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE affiliationTypeIds  IS NOT NULL AND affiliationTypeIds  NOT IN ('null', '[]')
    UNION ALL
    SELECT unique_id, explode(from_json(countries,          'array<string>')) AS val, 'countries'          AS col FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE countries          IS NOT NULL AND countries          NOT IN ('null', '[]')
)
SELECT col, COUNT(DISTINCT unique_id) AS facilities_affected, SUM(cnt - 1) AS redundant_entries
FROM (
    SELECT col, unique_id, val, COUNT(*) AS cnt
    FROM cols
    GROUP BY col, unique_id, val
    HAVING COUNT(*) > 1
)
GROUP BY col
ORDER BY redundant_entries DESC;