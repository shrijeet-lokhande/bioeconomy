import type { Map as MapLibreMap, LayerSpecification } from "maplibre-gl";
import { toMapSource, type MapOverlay } from "./layers";

function layerSpec(layer: LayerSpecification, sourceId: string): LayerSpecification {
  return { ...layer, source: sourceId } as LayerSpecification;
}

export function syncOverlays(map: MapLibreMap, overlays: readonly MapOverlay[]): void {
  const active = new Set(overlays.map((overlay) => overlay.id));
  const known = (map as MapLibreMap & { __bioOverlayIds?: Map<string, { sourceId: string; layerIds: string[] }> }).__bioOverlayIds ?? new Map();

  for (const overlay of [...overlays].sort((a, b) => a.order - b.order)) {
    if (!map.getSource(overlay.sourceId)) {
      map.addSource(overlay.sourceId, toMapSource(overlay.source));
    }
    for (const layer of overlay.layers) {
      if (!map.getLayer(layer.id)) map.addLayer(layerSpec(layer, overlay.sourceId));
      applyOverlayState(map, overlay);
    }
    known.set(overlay.id, { sourceId: overlay.sourceId, layerIds: overlay.layers.map((layer) => layer.id) });
  }

  for (const [overlayId, registered] of known) {
    if (active.has(overlayId)) continue;
    for (const id of registered.layerIds) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(registered.sourceId)) map.removeSource(registered.sourceId);
    known.delete(overlayId);
  }
  (map as MapLibreMap & { __bioOverlayIds?: Map<string, { sourceId: string; layerIds: string[] }> }).__bioOverlayIds = known;
}

export function applyOverlayState(map: MapLibreMap, overlay: MapOverlay): void {
  for (const layer of overlay.layers) {
    if (!map.getLayer(layer.id)) continue;
    map.setLayoutProperty(layer.id, "visibility", overlay.visible ? "visible" : "none");
    if (layer.type === "fill") map.setPaintProperty(layer.id, "fill-opacity", overlay.opacity);
    if (layer.type === "line") map.setPaintProperty(layer.id, "line-opacity", overlay.opacity);
    if (layer.type === "circle") map.setPaintProperty(layer.id, "circle-opacity", overlay.opacity);
    if (layer.type === "raster") map.setPaintProperty(layer.id, "raster-opacity", overlay.opacity);
    if (layer.type === "symbol") {
      map.setPaintProperty(layer.id, "icon-opacity", overlay.opacity);
      map.setPaintProperty(layer.id, "text-opacity", overlay.opacity);
    }
  }
}
