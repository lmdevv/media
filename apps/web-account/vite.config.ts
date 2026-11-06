import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const DEFAULT_PORT = 3002;

const parsePort = (value: string | undefined): number => {
  if (value === undefined || value === "") return DEFAULT_PORT;

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`ACCOUNT_PORT must be a TCP port number, got "${value}".`);
  }

  return port;
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");

  return {
    server: { port: parsePort(env["ACCOUNT_PORT"]) },
    resolve: { tsconfigPaths: true },
    plugins: [
      tailwindcss(),
      tanstackRouter({ target: "react", autoCodeSplitting: true, routeTreeFileHeader: [] }),
      react(),
    ],
  };
});
