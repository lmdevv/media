/// <reference types="node" />
// Metro for the iOS app. Expo's defaults already watch the pnpm workspace, so the SDK and contracts
// resolve from their sources; Uniwind compiles the Tailwind classes and must wrap the config last.
const { getDefaultConfig } = require("expo/metro-config");

const { withUniwindConfig } = require("uniwind/metro");

module.exports = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: "./src/global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
