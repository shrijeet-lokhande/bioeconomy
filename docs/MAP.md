# Map Explorer

## Current behavior

The protected `#/map-explorer` route lazy-loads MapLibre GL JS 6.17.0. Its map
instance is created and destroyed by the `MapLibreCanvas` React lifecycle; the
map component remains mounted when users switch configured base styles or
change overlays. A `ResizeObserver` plus a window resize fallback keeps the
canvas sized with its responsive workspace.

The default basemap is OpenFreeMap Liberty at
`https://tiles.openfreemap.org/styles/liberty`. OpenFreeMap currently offers
its public service without an API key or request/view quotas and allows
commercial use. MapLibre reads style attribution and displays it in its own
control. OpenFreeMap is provided as-is without an availability SLA, so the map
shows a retry action and can fall back to the configured default style. Review
the [OpenFreeMap terms](https://openfreemap.org/tos/) before production use.
The page also labels the rendered geography as a basemap, not a legal forest
boundary or forest-cover dataset.

## Environment

Copy `frontend/.env.example` values into the frontend build environment as
needed:

| Variable | Purpose |
| --- | --- |
| `VITE_MAP_STYLE_URL` | Optional replacement for the default Liberty style URL |
| `VITE_MAP_ATTRIBUTION` | Attribution shown with map provenance |
| `VITE_MAP_TERRAIN_STYLE_URL` | Optional MapLibre-compatible terrain/topographic style |
| `VITE_MAP_TERRAIN_ATTRIBUTION` | Attribution for that terrain style |
| `VITE_MAP_SATELLITE_STYLE_URL` | Optional MapLibre-compatible satellite style |
| `VITE_MAP_SATELLITE_ATTRIBUTION` | Attribution for that imagery style |

Terrain and satellite choices remain disabled until their style URL is
configured. MapTiler and similar commercial style URLs may include a public
browser token in the URL: restrict that token to the deployed origins and
required APIs, monitor provider quotas and terms, and never place a private
secret in a `VITE_` value. The default OpenFreeMap service needs no token.

## Overlay architecture

`src/map/layers.ts` defines typed raster, vector-tile and GeoJSON source
configurations; render layers; category; ordering; zoom range; opacity;
legend; attribution; and data provenance. `MAP_OVERLAYS` is the central
registry. `layerManager.ts` installs, updates, orders and removes sources and
layers without rebuilding MapLibre. `MapExplorerPage` groups available
overlays into forest boundaries, forest cover, geography, biomass,
agriculture and IoT sections, and shows source loading/error state, opacity,
visibility and legends. Feature selection shows only available primitive
attributes and source metadata; polygon and multipolygon area is calculated
from geometry when selectable features exist.

The registry is currently empty. No Forest Survey of India, Maharashtra
Forest Department, ISRO/NRSC Bhuvan, Survey of India, biomass, agriculture or
IoT dataset has been imported or configured. Do not add features until the
source, licence, coordinate system, publication date, import date and known
limitations can be recorded. Legal forest notifications, satellite-derived
forest cover, land-use classifications and administrative boundaries are
different products and must remain distinct.

## Location and privacy

The browser requests geolocation only after the user presses **My location**.
It validates coordinates, centers the map, renders a blue marker and
geodesic accuracy circle, and handles permission denial, unavailable service,
timeout, invalid values and insecure contexts. The current location is held in
component memory only and is not sent to the application backend or persisted.
Location access requires HTTPS or localhost. The user can press the control
again to recenter; there is no continuous tracking.

## Backend and future datasets

This first implementation uses external map styles and client-configured
GeoJSON/vector/raster overlays; it adds no backend endpoint, database table,
PostGIS extension or migration. PostgreSQL/PostGIS was not modified. Future
dataset retrieval should add authenticated FastAPI endpoints that return
small filtered GeoJSON or vector tile URLs and preserve dataset metadata.
Large rasters and spatial analysis belong on the separate authenticated
geospatial compute service, not in the browser or application VPS. The
frontend must receive processed results through the application API boundary;
it must not call the internal compute service directly.

## Performance

The map route is lazy-loaded, so the main app does not download MapLibre until
the user opens it. The current build emits the MapLibre chunk separately
(about 1.08 MB uncompressed / 296 KB gzip in the local production build).
No forest GeoJSON is bundled. Large future datasets should use vector tiles,
zoom bounds, server-side filtering and clustering where appropriate; avoid
shipping full national or global GeoJSON collections to the client.
