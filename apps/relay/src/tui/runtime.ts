/**
 * Inventoried Ink runtime requirements for the terminal dashboard. The
 * contracted framework is Ink 7 on React 19. It runs on the product Node.js 22
 * floor with no native FFI and no experimental Node flags.
 */
export const INK_VERSION = "7.1.1";
export const INK_REACT_VERSION_PIN = "19.2.8";

export const INK_RUNTIME_REQUIREMENTS = {
  framework: "ink",
  frameworkVersion: INK_VERSION,
  reactVersion: INK_REACT_VERSION_PIN,
  supportedProductRuntime: "node>=22",
  nativePackage: "none",
  liveNativeFlags: [],
  productionFallback: "none",
  supportedProductOs: "darwin",
  supportedProductArch: "arm64",
  screenReader: "unsupported-documented-limitation",
} as const;
