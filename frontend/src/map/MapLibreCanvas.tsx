import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Map as MapLibreMap,
  Marker,
  type ErrorEvent as MapErrorEvent,
  type GeoJSONSourceSpecification,
  type Map as MapInstance,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DEFAULT_BASEMAP, INITIAL_CENTER, INITIAL_ZOOM, type BasemapOption } from "./config";
import { syncOverlays } from "./layerManager";
import type { MapOverlay } from "./layers";

export type MapLoadState = "loading" | "ready" | "error" | "degraded";
export type OverlayLoadState = "loading" | "ready" | "error";
export interface SelectedMapFeature {
  layerName: string;
  properties: Record<string, string | number | boolean | null>;
  provenance: MapOverlay["provenance"];
  areaHa?: number;
}
export interface LocationResult {
  status: "idle" | "locating" | "located" | "error";
  message?: string;
  coordinates?: [number, number];
  accuracy?: number;
}
export interface MapCanvasActions {
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  locate(): void;
  fullscreen(): void;
}
interface Props {
  basemap: BasemapOption;
  overlays: readonly MapOverlay[];
  onLoadState(state: MapLoadState): void;
  onFeature(feature: SelectedMapFeature | null): void;
  onOverlayState(id: string, state: OverlayLoadState): void;
  onLocation(result: LocationResult): void;
  onView(center: [number, number], zoom: number): void;
}

function accuracyPolygon(lng: number, lat: number, radiusM: number): GeoJSONSourceSpecification["data"] {
  const points: [number, number][] = [];
  const earth = 6_371_000;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lng * Math.PI) / 180;
  for (let bearing = 0; bearing <= 360; bearing += 8) {
    const angle = (bearing * Math.PI) / 180;
    const angular = radiusM / earth;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) +
        Math.cos(lat1) * Math.sin(angular) * Math.cos(angle),
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(angle) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
    points.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [points] } } as GeoJSONSourceSpecification["data"];
}

function polygonAreaHa(geometry: unknown): number | undefined {
  if (!geometry || typeof geometry !== "object" || !("type" in geometry) || !("coordinates" in geometry)) return undefined;
  const candidate = geometry as { type: string; coordinates: unknown };
  if (candidate.type !== "Polygon" && candidate.type !== "MultiPolygon") return undefined;
  const polygons = (candidate.type === "Polygon" ? [candidate.coordinates] : candidate.coordinates) as number[][][][];
  const radius = 6_371_008.8;
  const ringArea = (ring: number[][]) => {
    let sum = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ring[index]!;
      const next = ring[(index + 1) % ring.length]!;
      const deltaLongitude = ((next[0]! - current[0]! + 540) % 360) - 180;
      sum += (deltaLongitude * Math.PI / 180) *
        (2 + Math.sin(current[1]! * Math.PI / 180) + Math.sin(next[1]! * Math.PI / 180));
    }
    return Math.abs(sum * radius * radius / 2);
  };
  const squareMeters = polygons.reduce((total, rings) => {
    if (!rings.length) return total;
    const exterior = ringArea(rings[0]!);
    const holes = rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
    return total + Math.max(0, exterior - holes);
  }, 0);
  return squareMeters / 10_000;
}

export const MapLibreCanvas = forwardRef<MapCanvasActions, Props>(function MapLibreCanvas(
  { basemap, overlays, onLoadState, onFeature, onOverlayState, onLocation, onView },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const overlaysRef = useRef(overlays);
  const markerRef = useRef<Marker | null>(null);
  const locationRef = useRef<{ coordinates: [number, number]; accuracy: number } | null>(null);
  const initialStyleRef = useRef(basemap.styleUrl);
  const [retryCount, setRetryCount] = useState(0);
  const [loadState, setLoadState] = useState<MapLoadState>("loading");
  const styleTimerRef = useRef<number | null>(null);
  overlaysRef.current = overlays;

  useImperativeHandle(ref, () => ({
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    reset: () => mapRef.current?.easeTo({ center: INITIAL_CENTER, zoom: INITIAL_ZOOM, bearing: 0, pitch: 0 }),
    locate: () => {
      const map = mapRef.current;
      if (!map) return;
      if (!window.isSecureContext) {
        onLocation({ status: "error", message: "Current location requires HTTPS or localhost." });
        return;
      }
      if (!navigator.geolocation) {
        onLocation({ status: "error", message: "This browser does not provide location services." });
        return;
      }
      onLocation({ status: "locating", message: "Requesting your location…" });
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          if (mapRef.current !== map) return;
          const { latitude, longitude, accuracy } = coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
              latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            onLocation({ status: "error", message: "The browser returned invalid coordinates." });
            return;
          }
          map.flyTo({ center: [longitude, latitude], zoom: 14, essential: true });
          markerRef.current?.remove();
          const element = document.createElement("div");
          element.className = "map-user-location-marker";
          element.setAttribute("aria-label", "Your current location");
          markerRef.current = new Marker({ element, color: "#1778c8" })
            .setLngLat([longitude, latitude]).addTo(map);
          const sourceId = "bioeconomy-current-location-accuracy";
          const feature = accuracyPolygon(longitude, latitude, Math.max(accuracy || 0, 1));
          locationRef.current = { coordinates: [longitude, latitude], accuracy };
          if (map.getSource(sourceId)) {
            (map.getSource(sourceId) as import("maplibre-gl").GeoJSONSource).setData(feature);
          } else {
            map.addSource(sourceId, { type: "geojson", data: feature });
            map.addLayer({
              id: `${sourceId}-fill`, type: "fill", source: sourceId,
              paint: { "fill-color": "#1778c8", "fill-opacity": 0.12 },
            });
            map.addLayer({
              id: `${sourceId}-outline`, type: "line", source: sourceId,
              paint: { "line-color": "#1778c8", "line-width": 1.5, "line-opacity": 0.7 },
            });
          }
          onLocation({ status: "located", coordinates: [longitude, latitude], accuracy });
        },
        (error) => {
          const message = error.code === error.PERMISSION_DENIED
            ? "Location permission was denied. Allow it in your browser settings to try again."
            : error.code === error.TIMEOUT
              ? "The location request timed out. Try again when your signal is clearer."
              : "Your location is unavailable. Check device location services and try again.";
          onLocation({ status: "error", message });
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
      );
    },
    fullscreen: () => {
      const node = mapRef.current?.getContainer();
      const request = node && !document.fullscreenElement ? node.requestFullscreen?.() : undefined;
      const exit = document.fullscreenElement ? document.exitFullscreen?.() : undefined;
      if (request) void request.catch(() => undefined);
      if (exit) void exit.catch(() => undefined);
    },
  }), [onLocation]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: basemap.styleUrl ?? DEFAULT_BASEMAP.styleUrl!,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: { compact: true },
      cooperativeGestures: true,
      maxZoom: 18,
    });
    mapRef.current = map;
    let loaded = false;
    const loadTimer = window.setTimeout(() => {
      if (!loaded) {
        setLoadState("error");
        onLoadState("error");
      }
    }, 15_000);
    const ready = () => {
      loaded = true;
      window.clearTimeout(loadTimer);
      if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current);
      styleTimerRef.current = null;
      setLoadState("ready");
      onLoadState("ready");
      syncOverlays(map, overlaysRef.current);
      overlaysRef.current.forEach((overlay) => onOverlayState(
        overlay.id,
        map.isSourceLoaded(overlay.sourceId) ? "ready" : "loading",
      ));
      const lastLocation = locationRef.current;
      if (lastLocation) {
        const sourceId = "bioeconomy-current-location-accuracy";
        const data = accuracyPolygon(...lastLocation.coordinates, Math.max(lastLocation.accuracy || 0, 1));
        map.addSource(sourceId, { type: "geojson", data });
        map.addLayer({ id: `${sourceId}-fill`, type: "fill", source: sourceId, paint: { "fill-color": "#1778c8", "fill-opacity": 0.12 } });
        map.addLayer({ id: `${sourceId}-outline`, type: "line", source: sourceId, paint: { "line-color": "#1778c8", "line-width": 1.5, "line-opacity": 0.7 } });
      }
    };
    const error = (event: MapErrorEvent) => {
      const sourceId = event ? (event as MapErrorEvent & { sourceId?: string }).sourceId : undefined;
      if (sourceId) {
        const overlay = overlaysRef.current.find((item) => item.sourceId === sourceId);
        if (overlay) {
          onOverlayState(overlay.id, "error");
          return;
        }
      }
      if (!loaded || !map.isStyleLoaded()) {
        setLoadState("error");
        onLoadState("error");
        if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current);
        styleTimerRef.current = null;
      } else {
        setLoadState("degraded");
        onLoadState("degraded");
      }
    };
    const sourceData = (event: { sourceId?: string; isSourceLoaded?: boolean }) => {
      const overlay = overlaysRef.current.find((item) => item.sourceId === event.sourceId);
      if (overlay) onOverlayState(overlay.id, event.isSourceLoaded ? "ready" : "loading");
    };
    const click = (event: MapMouseEvent) => {
      const ids = overlaysRef.current.flatMap((overlay) => overlay.layers.map((layer) => layer.id));
      const features = ids.length ? map.queryRenderedFeatures(event.point, { layers: ids }) : [];
      const selected = features[0];
      if (!selected) { onFeature(null); return; }
      const overlay = overlaysRef.current.find((item) => item.layers.some((layer) => layer.id === selected.layer.id));
      if (!overlay) return;
      const properties = Object.fromEntries(Object.entries(selected.properties ?? {})
        .filter(([key, value]) => !/token|password|secret|email/i.test(key) &&
          (value === null || ["string", "number", "boolean"].includes(typeof value)))
        .map(([key, value]) => [key, value as string | number | boolean | null]));
      onFeature({ layerName: overlay.name, properties, provenance: overlay.provenance, areaHa: polygonAreaHa(selected.geometry) });
    };
    const view = () => {
      const center = map.getCenter();
      onView([center.lng, center.lat], map.getZoom());
    };
    map.on("load", ready);
    map.on("style.load", ready);
    map.on("error", error);
    map.on("sourcedata", sourceData);
    map.on("click", click);
    map.on("moveend", view);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.resize()) : null;
    observer?.observe(containerRef.current);
    const handleResize = () => map.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.clearTimeout(loadTimer);
      if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current);
      styleTimerRef.current = null;
      observer?.disconnect();
      window.removeEventListener("resize", handleResize);
      map.off("load", ready);
      map.off("style.load", ready);
      map.off("error", error);
      map.off("sourcedata", sourceData);
      map.off("click", click);
      map.off("moveend", view);
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // Instance lifecycle is intentionally independent of style and overlays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCount]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !basemap.styleUrl) return;
    if (initialStyleRef.current === basemap.styleUrl) return;
    initialStyleRef.current = basemap.styleUrl;
    setLoadState("loading");
    onLoadState("loading");
    map.setStyle(basemap.styleUrl);
    if (styleTimerRef.current !== null) window.clearTimeout(styleTimerRef.current);
    styleTimerRef.current = window.setTimeout(() => {
      if (!map.isStyleLoaded()) {
        setLoadState("error");
        onLoadState("error");
      }
      styleTimerRef.current = null;
    }, 15_000);
  }, [basemap.styleUrl, onLoadState]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.isStyleLoaded()) syncOverlays(map, overlays);
  }, [overlays]);

  return (
    <div className="map-canvas-wrap">
      <div ref={containerRef} className="map-canvas" role="application" aria-label="Interactive forest geography map" />
      {loadState === "error" ? (
        <div className="map-load-error" role="alert">
          <strong>Map tiles are unavailable.</strong>
          <span>Check your connection or configured style, then retry.</span>
          <button type="button" className="map-tool-button" onClick={() => setRetryCount((count) => count + 1)}>Retry map</button>
        </div>
      ) : null}
      {loadState === "loading" ? <div className="map-load-pill" role="status">Loading map…</div> : null}
    </div>
  );
});
