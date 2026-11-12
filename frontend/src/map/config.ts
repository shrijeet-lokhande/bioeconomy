export interface BasemapOption {
  id: "forest" | "terrain" | "satellite";
  label: string;
  description: string;
  styleUrl?: string;
  attribution?: string;
  available: boolean;
}

const env = import.meta.env;
const OPENFREE_MAP = "https://tiles.openfreemap.org/styles/liberty";
const configuredStyleUrl = env.VITE_MAP_STYLE_URL?.trim();

export const BASEMAPS: readonly BasemapOption[] = [
  {
    id: "forest",
    label: "Forest terrain",
    description: "OpenFreeMap Liberty geographical map",
    styleUrl: configuredStyleUrl || OPENFREE_MAP,
    attribution: env.VITE_MAP_ATTRIBUTION?.trim() || (configuredStyleUrl
      ? "Attribution from the configured map style"
      : "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"),
    available: true,
  },
  {
    id: "terrain",
    label: "Topographic",
    description: "Optional configured terrain style",
    styleUrl: env.VITE_MAP_TERRAIN_STYLE_URL?.trim() || undefined,
    attribution: env.VITE_MAP_TERRAIN_ATTRIBUTION?.trim() || undefined,
    available: Boolean(env.VITE_MAP_TERRAIN_STYLE_URL?.trim()),
  },
  {
    id: "satellite",
    label: "Satellite",
    description: "Optional configured imagery style",
    styleUrl: env.VITE_MAP_SATELLITE_STYLE_URL?.trim() || undefined,
    attribution: env.VITE_MAP_SATELLITE_ATTRIBUTION?.trim() || undefined,
    available: Boolean(env.VITE_MAP_SATELLITE_STYLE_URL?.trim()),
  },
];

export const DEFAULT_BASEMAP = BASEMAPS[0]!;
export const INITIAL_CENTER: [number, number] = [75.9, 19.75];
export const INITIAL_ZOOM = 5.5;
