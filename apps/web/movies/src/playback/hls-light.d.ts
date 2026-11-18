/** hls.js ships its light build without typings; its API is the full build's, minus features. */
declare module "hls.js/light" {
  export { default } from "hls.js";
  export * from "hls.js";
}
