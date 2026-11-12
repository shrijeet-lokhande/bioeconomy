import { describe, expect, it, vi } from "vitest";
import { applyOverlayState, syncOverlays } from "./layerManager";
import type { MapOverlay } from "./layers";

function createMapStub() {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    __bioOverlayIds: new Map(),
    getSource: (id: string) => sources.get(id),
    addSource: vi.fn((id: string, spec: unknown) => sources.set(id, spec)),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    getLayer: (id: string) => layers.get(id),
    addLayer: vi.fn((spec: Record<string, unknown>) => layers.set(String(spec.id), spec)),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    setLayoutProperty: vi.fn(),
    setPaintProperty: vi.fn(),
  };
  return { map, sources, layers };
}

const overlay: MapOverlay = {
  id: "test-forest",
  sourceId: "bioeconomy-test-forest",
  name: "Test forest layer",
  description: "Sourced fixture used only in unit tests.",
  category: "forest-cover",
  source: { kind: "geojson", data: { type: "FeatureCollection", features: [] } },
  layers: [{ id: "bioeconomy-test-forest-fill", type: "fill", source: "ignored", paint: { "fill-color": "#267544" } } as never],
  visible: false,
  opacity: 0.4,
  order: 1,
  attribution: "Test only",
  provenance: {
    organization: "Unit test", dataset: "Fixture", sourceUrl: "https://example.invalid",
    coordinateReferenceSystem: "EPSG:4326", licence: "Test only", limitations: "Not real data",
  },
  legend: [],
};

describe("map overlay registry", () => {
  it("adds configured sources/layers and applies visibility and opacity", () => {
    const { map, sources, layers } = createMapStub();
    syncOverlays(map as never, [overlay]);
    expect(sources.has(overlay.sourceId)).toBe(true);
    expect(layers.has(overlay.layers[0]!.id)).toBe(true);
    expect(map.setLayoutProperty).toHaveBeenCalledWith(overlay.layers[0]!.id, "visibility", "none");
    expect(map.setPaintProperty).toHaveBeenCalledWith(overlay.layers[0]!.id, "fill-opacity", 0.4);
  });

  it("updates visibility and opacity without replacing the source", () => {
    const { map, sources } = createMapStub();
    syncOverlays(map as never, [overlay]);
    const updated = { ...overlay, visible: true, opacity: 0.8 };
    applyOverlayState(map as never, updated);
    expect(sources.size).toBe(1);
    expect(map.setLayoutProperty).toHaveBeenLastCalledWith(overlay.layers[0]!.id, "visibility", "visible");
    expect(map.setPaintProperty).toHaveBeenLastCalledWith(overlay.layers[0]!.id, "fill-opacity", 0.8);
  });

  it("removes sources and render layers when an overlay is removed", () => {
    const { map, sources, layers } = createMapStub();
    syncOverlays(map as never, [overlay]);
    syncOverlays(map as never, []);
    expect(sources.size).toBe(0);
    expect(layers.size).toBe(0);
  });
});
