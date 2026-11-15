// Module declarations for Vite's raw asset imports (the pixel icon SVG
// strings, see ui/pixicons.ts).
declare module "*.svg?raw" {
  const content: string;
  export default content;
}
