# NJ Absentee Owner Finder

A single-page tool: draw a rectangle on a map of New Jersey, get a table of every parcel inside it where the owner's mailing address is out of state **and** differs from the property address.

Live: https://asherstrell.github.io/nj-parcel-finder/

## How it works

- Static site, no backend. Open `index.html` in a browser.
- Pulls geometry and listing fields from NJ Office of GIS (NJOGIS) at `maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0`.
- Enriches the records with county-backed ownership and assessment data from `cache.njparcels.com/attributes/v1.0/nj/{pin}?owner=1&assessment=1` for any row that has a `PAMS_PIN`.
- Tries county-backed data first for mailing/property/owner plus assessment values (`land_value`, `improvement_value`, `net_value`, deed metadata) when available, then falls back to NJOGIS for missing values.
- Paginates 1,000 rows at a time; capped at 10,000 to avoid runaway requests on dense areas.

## Filters (both on by default)

- **Owner is out of state** (applies after county-backed enrichment)
- **Mailing ≠ property address** (applies after county-backed enrichment)
- **Sold after 2019 filter** is still applied at NJOGIS query time for performance.

## Known limitations

- Address compare is normalized (uppercase + punctuation removed). `"113 W 6TH ST"` and `"113 6TH ST"` normalize similarly; still expect occasional format-based false positives.
- Blank/malformed `CITY_STATE` values are treated as out-of-state for safety.
- No built-in owner-occupied flag exists in the dataset; mailing-vs-property is the standard proxy.
- Records without a `PAMS_PIN` cannot be county-enriched and are treated as NJOGIS-source only.
- Drawing a huge / dense area (e.g., all of Newark) can take 15+ seconds and may hit the 10,000-row cap.

## Data attribution

Parcel data © NJ Office of Information Technology, Office of GIS (NJOGIS). Base map © OpenStreetMap contributors.

## Local development

No build step. Serve the directory with any static file server:

```
cd nj-parcel-finder
python3 -m http.server 8000
# open http://localhost:8000
```

(File-protocol `file://` access also works.)
