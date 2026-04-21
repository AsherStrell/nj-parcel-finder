# NJ Absentee Owner Finder

A single-page tool: draw a rectangle on a map of New Jersey, get a table of every parcel inside it where the owner's mailing address is out of state **and** differs from the property address.

Live: https://asherstrell.github.io/nj-parcel-finder/

## How it works

- Static site, no backend. Open `index.html` in a browser.
- Queries the NJ Office of GIS (NJOGIS) public Cadastral Parcels service at `maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer/0`.
- Paginates 1,000 rows at a time; capped at 10,000 to avoid runaway requests on dense areas.

## Filters (both on by default)

- **Owner is out of state** — `CITY_STATE NOT LIKE '% NJ'`
- **Mailing ≠ property address** — `ST_ADDRESS <> PROP_LOC`

## Known limitations

- Address equality is literal. `"113 W 6TH ST"` and `"113 WEST SIXTH ST"` are treated as different — expect a few false positives.
- Blank/malformed `CITY_STATE` values pass the out-of-state filter.
- No built-in owner-occupied flag exists in the dataset; mailing-vs-property is the standard proxy.
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
