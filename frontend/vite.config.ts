import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Pin the origin to IPv4 loopback so cloudflared's 127.0.0.1 target and
    // Windows localhost resolution always reach the same listener.
    host: "127.0.0.1",
    // The tunnel launcher adds only its generated hostname through Vite's
    // __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS environment variable.
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:49173",
        changeOrigin: true,
      },
    },
  },
});
