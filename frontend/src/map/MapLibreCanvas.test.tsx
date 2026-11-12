// @vitest-environment jsdom
import { StrictMode, createRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, DEFAULT_BASEMAP } from "./config";
import { MapLibreCanvas, type MapCanvasActions, type MapLoadState } from "./MapLibreCanvas";
import type { MapOverlay } from "./layers";

const fake = vi.hoisted(() => {
  const instances: FakeMap[] = [];
  class FakeMap {
    events = new Map<string, Set<(event?: never) => void>>();
    sources = new Map<string, unknown>();
    layers = new Map<string, Record<string, unknown>>();
    removed = false;
    styleLoaded = false;
    setStyle = vi.fn((style: string) => {
      this.sources.clear(); this.layers.clear();
      this.styleLoaded = false;
      if (!style.includes("invalid")) queueMicrotask(() => this.emit("style.load"));
      return style;
    });
    queryRenderedFeatures = vi.fn((): Array<{ layer: { id: string }; properties: Record<string, unknown>; geometry: unknown }> => []);
    readonly options: { container: HTMLElement; style: string };
    constructor(options: { container: HTMLElement; style: string }) { this.options = options; instances.push(this); }
    on(event: string, callback: (event?: never) => void) {
      const handlers = this.events.get(event) ?? new Set(); handlers.add(callback); this.events.set(event, handlers);
      if (event === "load") queueMicrotask(() => this.emit("load"));
      return this;
    }
    off(event: string, callback: (event?: never) => void) { this.events.get(event)?.delete(callback); return this; }
    emit(event: string, payload?: never) {
      if (event === "load" || event === "style.load") this.styleLoaded = true;
      this.events.get(event)?.forEach((handler) => handler(payload));
    }
    addControl() { return this; }
    addSource(id: string, source: unknown) { this.sources.set(id, source); return this; }
    getSource(id: string) { return this.sources.get(id); }
    removeSource(id: string) { this.sources.delete(id); return this; }
    addLayer(layer: Record<string, unknown>) { this.layers.set(String(layer.id), layer); return this; }
    getLayer(id: string) { return this.layers.get(id); }
    removeLayer(id: string) { this.layers.delete(id); return this; }
    setLayoutProperty = vi.fn();
    setPaintProperty = vi.fn();
    isStyleLoaded() { return this.styleLoaded; }
    isSourceLoaded() { return true; }
    getContainer() { return this.options.container; }
    getCenter() { return { lng: 75.9, lat: 19.75 }; }
    getZoom() { return 5.5; }
    resize = vi.fn();
    zoomIn = vi.fn();
    zoomOut = vi.fn();
    easeTo = vi.fn();
    flyTo = vi.fn();
    remove() { this.removed = true; }
  }
  class FakeMarker {
    remove = vi.fn();
    setLngLat = vi.fn(() => this);
    addTo = vi.fn(() => this);
    readonly options: { element: HTMLElement; color?: string };
    constructor(options: { element: HTMLElement; color?: string }) { this.options = options; }
  }
  return { instances, FakeMap, FakeMarker };
});

vi.mock("maplibre-gl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("maplibre-gl")>();
  return { ...actual, Map: fake.FakeMap, Marker: fake.FakeMarker };
});

const overlay: MapOverlay = {
  id: "forest-demo-source", sourceId: "forest-demo-source", name: "Forest demo",
  description: "Test only", category: "forest-cover",
  source: { kind: "geojson", data: { type: "FeatureCollection", features: [] } },
  layers: [{ id: "forest-demo-fill", type: "fill", source: "forest-demo-source", paint: { "fill-color": "#367b4e" } }],
  visible: true, opacity: 0.8, order: 1, attribution: "Test",
  provenance: { organization: "Test", dataset: "Fixture", sourceUrl: "https://example.invalid", coordinateReferenceSystem: "EPSG:4326", licence: "Test", limitations: "Not real data" },
  legend: [],
};

function renderCanvas(props: Partial<ComponentProps<typeof MapLibreCanvas>> = {}) {
  const onLoadState = props.onLoadState ?? vi.fn<(state: MapLoadState) => void>();
  const onLocation = props.onLocation ?? vi.fn();
  const onFeature = props.onFeature ?? vi.fn();
  const onOverlayState = props.onOverlayState ?? vi.fn();
  const onView = props.onView ?? vi.fn();
  return {
    ...render(<MapLibreCanvas basemap={DEFAULT_BASEMAP} overlays={[]} onLoadState={onLoadState} onLocation={onLocation} onFeature={onFeature} onOverlayState={onOverlayState} onView={onView} {...props} />),
    onLoadState, onLocation, onFeature, onOverlayState, onView,
  };
}

afterEach(() => {
  cleanup();
  fake.instances.length = 0;
  vi.restoreAllMocks();
});

describe("MapLibre lifecycle and controls", () => {
  it("cleans every Strict Mode map instance on unmount", async () => {
    const props = { basemap: DEFAULT_BASEMAP, overlays: [], onLoadState: vi.fn(), onFeature: vi.fn(), onOverlayState: vi.fn(), onLocation: vi.fn(), onView: vi.fn() };
    const view = render(<StrictMode><MapLibreCanvas {...props} /></StrictMode>);
    await waitFor(() => expect(fake.instances.length).toBe(2));
    view.unmount();
    expect(fake.instances.every((map) => map.removed)).toBe(true);
  });

  it("switches styles without constructing another map", async () => {
    const view = renderCanvas();
    await waitFor(() => expect(view.onLoadState).toHaveBeenCalledWith("ready"));
    const map = fake.instances[0]!;
    view.rerender(<MapLibreCanvas basemap={{ ...BASEMAPS[1]!, available: true, styleUrl: "https://example.test/topographic.json" }} overlays={[]} onLoadState={view.onLoadState} onFeature={view.onFeature} onOverlayState={view.onOverlayState} onLocation={view.onLocation} onView={view.onView} />);
    expect(map.setStyle).toHaveBeenCalledWith("https://example.test/topographic.json");
    expect(fake.instances).toHaveLength(1);
  });

  it("reports denied geolocation only after the location control is invoked", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const getCurrentPosition = vi.fn((_success: PositionCallback, failure?: PositionErrorCallback) => failure?.({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    const ref = createRef<MapCanvasActions>();
    const onLocation = vi.fn();
    render(<MapLibreCanvas ref={ref} basemap={DEFAULT_BASEMAP} overlays={[]} onLoadState={vi.fn()} onFeature={vi.fn()} onOverlayState={vi.fn()} onLocation={onLocation} onView={vi.fn()} />);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.instances[0]).toBeDefined());
    act(() => ref.current?.locate());
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(onLocation).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", message: expect.stringMatching(/permission was denied/i) }));
  });

  it("centres on a valid location and provides an accuracy polygon", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 19.1, longitude: 73.2, accuracy: 25 } } as GeolocationPosition));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    const ref = createRef<MapCanvasActions>();
    const onLocation = vi.fn();
    render(<MapLibreCanvas ref={ref} basemap={DEFAULT_BASEMAP} overlays={[]} onLoadState={vi.fn()} onFeature={vi.fn()} onOverlayState={vi.fn()} onLocation={onLocation} onView={vi.fn()} />);
    await waitFor(() => expect(fake.instances[0]).toBeDefined());
    act(() => ref.current?.locate());
    expect(fake.instances[0]!.flyTo).toHaveBeenCalledWith({ center: [73.2, 19.1], zoom: 14, essential: true });
    expect(fake.instances[0]!.sources.has("bioeconomy-current-location-accuracy")).toBe(true);
    expect(onLocation).toHaveBeenLastCalledWith(expect.objectContaining({ status: "located", accuracy: 25 }));
  });

  it.each([
    [2, /unavailable/i],
    [3, /timed out/i],
  ])("explains geolocation error code %i", async (code, expected) => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    const failure = vi.fn((_error: GeolocationPositionError) => undefined);
    const getCurrentPosition = vi.fn((_success: PositionCallback, error?: PositionErrorCallback) => error?.({ code, message: "test", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    const ref = createRef<MapCanvasActions>();
    const onLocation = vi.fn();
    render(<MapLibreCanvas ref={ref} basemap={DEFAULT_BASEMAP} overlays={[]} onLoadState={vi.fn()} onFeature={vi.fn()} onOverlayState={vi.fn()} onLocation={onLocation} onView={vi.fn()} />);
    await waitFor(() => expect(fake.instances[0]).toBeDefined());
    act(() => ref.current?.locate());
    expect(failure).not.toHaveBeenCalled();
    expect(onLocation).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", message: expect.stringMatching(expected) }));
  });

  it("reports insecure context and unavailable geolocation without requesting permission", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    const ref = createRef<MapCanvasActions>();
    const onLocation = vi.fn();
    render(<MapLibreCanvas ref={ref} basemap={DEFAULT_BASEMAP} overlays={[]} onLoadState={vi.fn()} onFeature={vi.fn()} onOverlayState={vi.fn()} onLocation={onLocation} onView={vi.fn()} />);
    await waitFor(() => expect(fake.instances[0]).toBeDefined());
    act(() => ref.current?.locate());
    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(onLocation).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", message: expect.stringMatching(/requires HTTPS/i) }));
  });

  it("reports an unavailable style without crashing the map", async () => {
    const view = renderCanvas();
    await waitFor(() => expect(view.onLoadState).toHaveBeenCalledWith("ready"));
    const map = fake.instances[0]!;
    view.rerender(<MapLibreCanvas basemap={{ ...BASEMAPS[1]!, available: true, styleUrl: "https://invalid.test/style.json" }} overlays={[]} onLoadState={view.onLoadState} onFeature={view.onFeature} onOverlayState={view.onOverlayState} onLocation={view.onLocation} onView={view.onView} />);
    act(() => map.emit("error"));
    expect(view.onLoadState).toHaveBeenLastCalledWith("error");
  });

  it("shows sourced feature attributes and calculates polygon area on selection", async () => {
    const onFeature = vi.fn();
    const view = renderCanvas({ overlays: [overlay], onFeature });
    await waitFor(() => expect(view.onLoadState).toHaveBeenCalledWith("ready"));
    const map = fake.instances[0]!;
    map.queryRenderedFeatures.mockReturnValue([{
      layer: { id: "forest-demo-fill" }, properties: { label: "Reserved Forest", hectares: 2.5 },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] },
    }]);
    act(() => map.emit("click", { point: { x: 1, y: 1 } } as never));
    expect(onFeature).toHaveBeenCalledWith(expect.objectContaining({ layerName: "Forest demo", properties: { label: "Reserved Forest", hectares: 2.5 }, areaHa: expect.any(Number) }));
  });

  it("reports overlay loading and provider source errors", async () => {
    const onOverlayState = vi.fn();
    const view = renderCanvas({ overlays: [overlay], onOverlayState });
    await waitFor(() => expect(view.onLoadState).toHaveBeenCalledWith("ready"));
    const map = fake.instances[0]!;
    act(() => map.emit("sourcedata", { sourceId: overlay.sourceId, isSourceLoaded: true } as never));
    expect(onOverlayState).toHaveBeenLastCalledWith(overlay.id, "ready");
    act(() => map.emit("error", { sourceId: overlay.sourceId } as never));
    expect(onOverlayState).toHaveBeenLastCalledWith(overlay.id, "error");
  });

  it("exposes a real default map and marks optional styles unavailable when unset", () => {
    expect(DEFAULT_BASEMAP.styleUrl).toBe("https://tiles.openfreemap.org/styles/liberty");
    expect(BASEMAPS.find((item) => item.id === "terrain")?.available).toBe(false);
    expect(BASEMAPS.find((item) => item.id === "satellite")?.available).toBe(false);
  });
});
