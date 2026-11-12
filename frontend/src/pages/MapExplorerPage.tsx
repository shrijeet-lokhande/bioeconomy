import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { BASEMAPS, DEFAULT_BASEMAP } from "../map/config";
import { MAP_OVERLAYS, OVERLAY_CATEGORIES, type MapOverlay } from "../map/layers";
import type {
  LocationResult,
  MapCanvasActions,
  MapLoadState,
  OverlayLoadState,
  SelectedMapFeature,
} from "../map/MapLibreCanvas";

const MapLibreCanvas = lazy(() => import("../map/MapLibreCanvas").then((module) => ({ default: module.MapLibreCanvas })));

export function MapExplorerPage() {
  const actionsRef = useRef<MapCanvasActions>(null);
  const [basemapId, setBasemapId] = useState(DEFAULT_BASEMAP.id);
  const [overlays, setOverlays] = useState<readonly MapOverlay[]>(MAP_OVERLAYS);
  const [layersOpen, setLayersOpen] = useState(true);
  const [loadState, setLoadState] = useState<MapLoadState>("loading");
  const [location, setLocation] = useState<LocationResult>({ status: "idle" });
  const [feature, setFeature] = useState<SelectedMapFeature | null>(null);
  const [overlayStates, setOverlayStates] = useState<Record<string, OverlayLoadState>>({});
  const [view, setView] = useState<{ center: [number, number]; zoom: number }>({
    center: [75.9, 19.75], zoom: 5.5,
  });
  const basemap = BASEMAPS.find((item) => item.id === basemapId) ?? DEFAULT_BASEMAP;

  const handleLoad = useCallback((state: MapLoadState) => setLoadState(state), []);
  const handleLocation = useCallback((result: LocationResult) => setLocation(result), []);
  const handleFeature = useCallback((next: SelectedMapFeature | null) => setFeature(next), []);
  const handleOverlayState = useCallback((id: string, state: OverlayLoadState) => {
    setOverlayStates((current) => current[id] === state ? current : { ...current, [id]: state });
  }, []);
  const handleView = useCallback((center: [number, number], zoom: number) => setView({ center, zoom }), []);
  const updateOverlay = (id: string, patch: Partial<Pick<MapOverlay, "visible" | "opacity">>) => {
    setOverlays((current) => current.map((overlay) => overlay.id === id ? { ...overlay, ...patch } : overlay));
  };

  const groups = useMemo(() => OVERLAY_CATEGORIES.map((category) => ({
    ...category,
    layers: overlays.filter((overlay) => overlay.category === category.id),
  })), [overlays]);
  const latitude = view.center[1];
  const longitude = view.center[0];

  return (
    <section className="map-page" aria-labelledby="map-title">
      <header className="map-page-header">
        <div>
          <p className="map-eyebrow">Forest intelligence</p>
          <h1 id="map-title">Map Explorer</h1>
          <p className="map-intro">Explore geographical context and sourced environmental layers. Forest datasets will appear here when authoritative data is configured.</p>
        </div>
        <span className={`map-status map-status--${loadState}`} role="status">
          <span aria-hidden="true" />{loadState === "ready" ? "Map ready" : loadState === "degraded" ? "Some map requests failed" : loadState === "error" ? "Map unavailable" : "Loading map"}
        </span>
      </header>

      <div className={`map-dashboard ${layersOpen ? "" : "map-dashboard--wide"}`}>
        <div className="map-stage">
          <Suspense fallback={<div className="map-placeholder" role="status">Preparing interactive map…</div>}>
            <MapLibreCanvas
              ref={actionsRef}
              basemap={basemap}
              overlays={overlays}
              onLoadState={handleLoad}
              onFeature={handleFeature}
              onOverlayState={handleOverlayState}
              onLocation={handleLocation}
              onView={handleView}
            />
          </Suspense>
          <div className="map-custom-controls" aria-label="Map controls">
            <button type="button" className="map-tool-button" aria-label="Zoom in" onClick={() => actionsRef.current?.zoomIn()}>+</button>
            <button type="button" className="map-tool-button" aria-label="Zoom out" onClick={() => actionsRef.current?.zoomOut()}>−</button>
            <button type="button" className="map-tool-button" onClick={() => actionsRef.current?.reset()}>Reset view</button>
            <button type="button" className="map-tool-button map-location-button" onClick={() => actionsRef.current?.locate()} disabled={location.status === "locating"}>
              {location.status === "locating" ? "Locating…" : "◎ My location"}
            </button>
            <button type="button" className="map-tool-button" onClick={() => actionsRef.current?.fullscreen()}>Fullscreen</button>
            {loadState === "error" && basemap.id !== DEFAULT_BASEMAP.id ? (
              <button type="button" className="map-tool-button" onClick={() => setBasemapId(DEFAULT_BASEMAP.id)}>Use forest map</button>
            ) : null}
          </div>
          <div className="map-coordinate-readout" aria-live="polite">
            {Math.abs(latitude).toFixed(4)}° {latitude < 0 ? "S" : "N"} · {Math.abs(longitude).toFixed(4)}° {longitude < 0 ? "W" : "E"} · z{view.zoom.toFixed(1)}
          </div>
        </div>

        {layersOpen ? (
          <aside className="map-sidebar" aria-label="Map layers and details">
            <div className="map-panel-heading">
              <div><span className="map-eyebrow">Control centre</span><h2>Map layers</h2></div>
              <button type="button" className="map-icon-button" aria-label="Collapse map layer panel" onClick={() => setLayersOpen(false)}>‹</button>
            </div>
            <label className="map-select-label" htmlFor="map-basemap">Base map</label>
            <select id="map-basemap" value={basemapId} onChange={(event) => setBasemapId(event.target.value as typeof basemapId)}>
              {BASEMAPS.map((option) => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : " · not configured"}</option>)}
            </select>
            <p className="map-basemap-description">{basemap.description}</p>
            {location.status === "error" || location.status === "locating" ? (
              <div className={`map-notice ${location.status === "error" ? "map-notice--error" : ""}`} role={location.status === "error" ? "alert" : "status"}>{location.message}</div>
            ) : null}
            {location.status === "located" && location.coordinates ? (
              <div className="map-notice map-notice--location" role="status">Your location · ±{Math.round(location.accuracy ?? 0)} m accuracy</div>
            ) : null}
            <div className="map-layer-groups">
              {groups.map((group) => (
                <section className="map-layer-group" key={group.id}>
                  <h3>{group.label}</h3>
                  {group.layers.length ? group.layers.map((layer) => (
                    <div className="map-layer-row" key={layer.id}>
                      <label><input type="checkbox" checked={layer.visible} onChange={(event) => updateOverlay(layer.id, { visible: event.target.checked })} />{layer.name}</label>
                      <small className={`map-overlay-status map-overlay-status--${overlayStates[layer.id] ?? "loading"}`}>
                        {overlayStates[layer.id] === "ready" ? "Layer ready" : overlayStates[layer.id] === "error" ? "Layer unavailable" : "Loading layer"}
                      </small>
                      <input aria-label={`${layer.name} opacity`} type="range" min="0" max="1" step="0.05" value={layer.opacity} onChange={(event) => updateOverlay(layer.id, { opacity: Number(event.target.value) })} />
                      {layer.visible ? layer.legend.map((item) => <span className="map-legend-item" key={item.label}><i style={{ backgroundColor: item.color }} />{item.label}</span>) : null}
                    </div>
                  )) : <p className="map-unavailable">No verified layer configured</p>}
                </section>
              ))}
            </div>
            {feature ? <FeatureDetails feature={feature} /> : (
              <div className="map-feature-empty"><h3>Feature details</h3><p>Select a configured map feature to inspect its sourced attributes.</p></div>
            )}
            <p className="map-provenance-note">No government forest boundary, forest-cover, biomass, agriculture, or sensor dataset is currently connected.</p>
          </aside>
        ) : (
          <button type="button" className="map-expand-panel" onClick={() => setLayersOpen(true)}>Layers and details ›</button>
        )}
      </div>
      <div className="map-data-footnote">
        <strong>Data integrity</strong>
        <span>Basemap geography is not a legal forest boundary or a forest-cover assessment. No synthetic forest or biomass features are displayed.</span>
        {basemap.attribution ? <small>{basemap.attribution}</small> : null}
      </div>
    </section>
  );
}

function FeatureDetails({ feature }: { feature: SelectedMapFeature }) {
  return (
    <section className="map-feature-details" aria-label="Selected feature details">
      <h3>{feature.layerName}</h3>
      {Object.entries(feature.properties).map(([name, value]) => (
        <div className="map-feature-property" key={name}><span>{name}</span><strong>{String(value ?? "—")}</strong></div>
      ))}
      {feature.areaHa !== undefined ? <div className="map-feature-property"><span>Area</span><strong>{feature.areaHa.toLocaleString()} ha</strong></div> : null}
      <p>{feature.provenance.organization} · {feature.provenance.dataset}</p>
      <small>{feature.provenance.coordinateReferenceSystem} · {feature.provenance.licence}</small>
      {feature.provenance.publicationDate ? <small>Published {feature.provenance.publicationDate}</small> : null}
      <a href={feature.provenance.sourceUrl} target="_blank" rel="noreferrer">View source</a>
    </section>
  );
}
