import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Connect, type Plugin } from "vite";

// Cross-origin isolation lets the speech models use multi-threaded WebAssembly,
// which is much faster when a laptop has no usable WebGPU.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const RUNTIME_DIR = "node_modules/onnxruntime-web/dist";
const RUNTIME_FILE = /^ort-wasm-simd-threaded(\.[a-z]+)?\.(wasm|mjs)$/;

/**
 * Serves the speech runtime's WebAssembly from this app at /ort/. No CDN is
 * contacted at run time, which matters for a tool that promises nothing from a
 * call leaves your device.
 */
function speechRuntime(): Plugin {
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const name = (req.url ?? "").split("?")[0].replace(/^\//, "");
    if (!RUNTIME_FILE.test(name)) return next();
    res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    // Without these, the browser blocks the runtime's thread workers and loading hangs silently.
    for (const [header, value] of Object.entries(isolationHeaders)) res.setHeader(header, value);
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    fs.createReadStream(path.join(RUNTIME_DIR, name)).pipe(res);
  };
  return {
    name: "speech-runtime",
    configureServer: (server) => void server.middlewares.use("/ort", serve),
    configurePreviewServer: (server) => void server.middlewares.use("/ort", serve),
    writeBundle(options) {
      const out = path.join(options.dir ?? "dist", "ort");
      fs.mkdirSync(out, { recursive: true });
      for (const file of fs.readdirSync(RUNTIME_DIR)) {
        if (RUNTIME_FILE.test(file)) fs.copyFileSync(path.join(RUNTIME_DIR, file), path.join(out, file));
      }
    },
  };
}

export default defineConfig({
  plugins: [speechRuntime()],
  server: { port: 5173, strictPort: true, headers: isolationHeaders },
  preview: { port: 5173, strictPort: true, headers: isolationHeaders },
  worker: { format: "es" },
  // The runtime loads its own WebAssembly at run time, so the bundler must leave it alone.
  optimizeDeps: { exclude: ["@huggingface/transformers", "onnxruntime-web"] },
  build: { target: "es2022" },
});
