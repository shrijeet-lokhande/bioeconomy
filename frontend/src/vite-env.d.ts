/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAP_STYLE_URL?: string;
  readonly VITE_MAP_ATTRIBUTION?: string;
  readonly VITE_MAP_TERRAIN_STYLE_URL?: string;
  readonly VITE_MAP_TERRAIN_ATTRIBUTION?: string;
  readonly VITE_MAP_SATELLITE_STYLE_URL?: string;
  readonly VITE_MAP_SATELLITE_ATTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
