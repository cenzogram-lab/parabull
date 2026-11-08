/** hls.js ships types for its main entry only; the light build (hls.js/light) has the same API. */
declare module "hls.js/light" {
  export * from "hls.js";
  export { default } from "hls.js";
}
