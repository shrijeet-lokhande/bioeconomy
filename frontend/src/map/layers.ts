import type {
  LayerSpecification,
  RasterSourceSpecification,
  SourceSpecification,
  VectorSourceSpecification,
} from "maplibre-gl";

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: object | null;
    properties?: Record<string, unknown> | null;
    id?: string | number;
  }>;
}

export type OverlayCategory =
  | "forest-boundaries"
  | "forest-cover"
  | "geography"
  | "biomass"
  | "agriculture"
  | "iot";

export type OverlaySource =
  | { kind: "geojson"; data: GeoJSONFeatureCollection | string; cluster?: boolean }
  | { kind: "vector"; tiles: string[]; url?: string; minzoom?: number; maxzoom?: number }
  | { kind: "raster"; tiles: string[]; tileSize?: number; minzoom?: number; maxzoom?: number };

export interface LegendItem {
  label: string;
  color: string;
  line?: boolean;
}

export interface DataProvenance {
  organization: string;
  dataset: string;
  sourceUrl: string;
  publicationDate?: string;
  importedAt?: string;
  coordinateReferenceSystem: string;
  licence: string;
  limitations: string;
}

export interface MapOverlay {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  category: OverlayCategory;
  source: OverlaySource;
  layers: LayerSpecification[];
  visible: boolean;
  opacity: number;
  minZoom?: number;
  maxZoom?: number;
  order: number;
  attribution: string;
  provenance: DataProvenance;
  legend: LegendItem[];
}

export const OVERLAY_CATEGORIES: readonly { id: OverlayCategory; label: string }[] = [
  { id: "forest-boundaries", label: "Forest boundaries" },
  { id: "forest-cover", label: "Forest cover" },
  { id: "geography", label: "Geography" },
  { id: "biomass", label: "Biomass" },
  { id: "agriculture", label: "Agriculture" },
  { id: "iot", label: "IoT monitoring" },
];

/** Registry contains only sourced, configured data. Intentionally empty until
 * an authoritative dataset is selected and its licence/provenance recorded. */
export const MAP_OVERLAYS: readonly MapOverlay[] = [];

export function toMapSource(source: OverlaySource): SourceSpecification {
  if (source.kind === "geojson") {
    return {
      type: "geojson",
      data: source.data,
      ...(source.cluster ? { cluster: true } : {}),
    } as SourceSpecification;
  }
  if (source.kind === "vector") {
    const spec: VectorSourceSpecification = {
      type: "vector",
      tiles: source.tiles,
      ...(source.url ? { url: source.url } : {}),
      ...(source.minzoom !== undefined ? { minzoom: source.minzoom } : {}),
      ...(source.maxzoom !== undefined ? { maxzoom: source.maxzoom } : {}),
    };
    return spec;
  }
  const spec: RasterSourceSpecification = {
    type: "raster",
    tiles: source.tiles,
    tileSize: source.tileSize ?? 256,
    ...(source.minzoom !== undefined ? { minzoom: source.minzoom } : {}),
    ...(source.maxzoom !== undefined ? { maxzoom: source.maxzoom } : {}),
  };
  return spec;
}

export function overlayLayerIds(overlay: MapOverlay): string[] {
  return overlay.layers.map((layer) => layer.id);
}
