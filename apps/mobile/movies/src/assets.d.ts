/** Images bundled with the app resolve to Metro asset IDs. */
declare module "*.jpg" {
  const source: number;
  export default source;
}

declare module "*.png" {
  const source: number;
  export default source;
}

declare module "*.css";
