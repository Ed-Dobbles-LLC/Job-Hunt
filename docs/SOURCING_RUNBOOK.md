# Sourcing & Packet Runbook

## 1. Inventory changes are a THREE-step process

`/api/profile/current` reads **DB-first** from `app_settings.experience_inventory`,
falling back to the repo file only if that row is missing. A stale DB row silently
shadows a corrected file. A green deploy on the right SHA can still serve wrong facts.

```
1. commit + push experience_inventory.json
2. wait for Railway deploy -> SUCCESS  (verify the SHA, not the status)
3. curl -X POST .../api/profile/sync-from-file -d '{"confirm":true}'
4. re-pull /api/profile/current and diff
```

Skipping step 3 is the failure mode that shipped four wrong facts through 18 packets.

## 2. Sourcing — Apify

Actor: `blackfalcondata/linkedin-job-scraper` (NOT `curious_coder/...`; ~30 lookalikes exist).
Chosen for `incrementalMode` + `stateKey` + `outputMode: new-only`, `excludeCompanies`,
and `descriptionFormat: markdown`.

Configs: `config/apify-task-A-minneapolis.json`, `config/apify-task-B-national.json`

Known actor defects:
- `removeAgency: true` does NOT work. Filter agencies in triage instead.
- `skipReposts: true` misses same-run duplicates.
- `experienceLevel` / `workType` / `jobType` are POST-filters applied to the detail
  page. They are silently ignored unless `enrichDetails: true`. `maxResults` therefore
  never binds and yields look low — that is expected, not a failure.
- `salaryIsPredicted: true` values are garbage (one returned "$258–$127,900").
  Only trust salary when that flag is false.
- Do NOT use `excludeKeywords`. "associate" kills the "Associate Director" band;
  "specialist"/"coordinator" compound it. Filter titles in triage.
- Do NOT set `salaryMin`. LinkedIn narrows to its nearest band at SEARCH time and
  can gut the pull. Filter comp in triage where it is visible and reversible.

Apify dataset reads are **not token-gated** — `GET /v2/datasets/{id}/items` and
`GET /v2/actor-runs/{id}` work unauthenticated. Only a run ID or dataset ID is needed.

## 3. Triage

```
node scripts/triageApify.cjs <datasetId> [<datasetId>...]
```

Dedupes against the live tracker (company + already-applied), flags agencies by name
AND by `industry`, and surfaces financial/pharma **flagged rather than killed** —
those are case-by-case exceptions, and auto-killing them is stricter than the
operating law.

Comp floor: $175K hard, $200K target. Employer-stated only.

## 4. Build + scan

```
node scripts/renderMasterResume.cjs
soffice --headless --convert-to pdf <docx> --outdir .
pdftotext -layout <pdf> out.txt
node scripts/defectScan.cjs out.txt [cover.txt]     # exit 1 = DO NOT DELIVER
```

The Dockerfile already installs `libreoffice-writer` and `poppler-utils`, so this
pipeline runs server-side, not only locally.

`defectScan.cjs` is a hard gate. A failing packet must not reach Ed or an employer.

## 5. Standing filters

Hard pass: below VP/Sr Director · non-US · hands-on engineering or architecture-primary ·
governance/MDM-primary · agencies · expired postings · product-management-primary.
Case-by-case (surface flagged): financial institutions, pharma.

Closed — do not resurface: Hill's Pet Nutrition, PadSplit, Microsoft, Lyra Health,
Sprouts Farmers Market, Goodyear, Discount Tire, Perrigo, Patrick Industries.
