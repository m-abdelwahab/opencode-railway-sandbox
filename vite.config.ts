import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds the Desktop panel (src/gui.tsx) into dist/gui-experimental.cjs.
export default defineConfig({ plugins: [gui()] })
