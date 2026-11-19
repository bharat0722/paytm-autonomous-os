import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// UI lives in apps/web (Owner 03). The API runs on 3001 and is proxied so the
// browser always talks to one origin.
const apiPort = Number(process.env.API_PORT ?? 3001)

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } }
  },
  build: { outDir: "../../dist/web", emptyOutDir: true }
})
