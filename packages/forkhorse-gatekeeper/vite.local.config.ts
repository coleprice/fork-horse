import { defineConfig } from "vite";
import { createRequire } from "node:module";
const fromFrontend = createRequire(new URL("../../cloudflare-os/packages/workshop-frontend/package.json", import.meta.url));
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["capnweb", "react", "react-dom", "@tanstack/react-router"], alias: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@tanstack/react-router"].map(name => ({ find: new RegExp(`^${name.replaceAll("/", "\\/")}$`), replacement: fromFrontend.resolve(name) })) },
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
});
