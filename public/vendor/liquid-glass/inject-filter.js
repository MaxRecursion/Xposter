import {
  SCALE_MIN,
  SCALE_MAX,
  FREQUENCY_PEAK_RATIO,
  FILTER_REGION_MARGIN,
  FILTER_REGION_SIZE,
  FILTER_DEFAULTS,
} from "./constants.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function clampScale(value) {
  return Math.max(SCALE_MIN, Math.min(Number(value), SCALE_MAX));
}

// Returns the existing <animate> child of feTurbulence, or null.
// There must be at most one; duplicates would fight each other.
function findTurbulenceAnimation(turbulenceEl) {
  return turbulenceEl?.querySelector("animate") ?? null;
}

function buildTurbulenceAnimation({ baseFrequency, duration }) {
  const animate = document.createElementNS(SVG_NS, "animate");
  const from = Number(baseFrequency);
  const to   = from * FREQUENCY_PEAK_RATIO;

  animate.setAttribute("attributeName", "baseFrequency");
  animate.setAttribute("dur", duration);
  animate.setAttribute("values", `${from};${to};${from}`);
  animate.setAttribute("repeatCount", "indefinite");

  return animate;
}

/**
 * Injects an SVG filter into the document that produces the liquid-glass
 * refraction distortion.  Idempotent — calling it again with the same `id`
 * updates the existing filter rather than creating a duplicate.
 *
 * @param {import("../../src/index.d.ts").FilterOptions} [options]
 * @returns {SVGFilterElement} The created or updated <filter> element.
 */
export function injectLiquidGlassFilter(options = {}) {
  const config = { ...FILTER_DEFAULTS, ...options };

  // Respect the user's OS-level motion preference.
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const existingFilter = document.getElementById(config.id);
  if (existingFilter) {
    updateLiquidGlassFilter(config.id, config);
    return existingFilter;
  }

  // The SVG host is hidden and has no interactive role — screen readers skip it.
  const svgHost = document.createElementNS(SVG_NS, "svg");
  svgHost.setAttribute("aria-hidden", "true");
  svgHost.setAttribute("focusable", "false");
  svgHost.setAttribute("width", "0");
  svgHost.setAttribute("height", "0");
  svgHost.classList.add("liquid-glass-filter-root");

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", config.id);
  // Extend the filter region so displaced pixels at the edges aren't clipped.
  filter.setAttribute("x", `-${FILTER_REGION_MARGIN}`);
  filter.setAttribute("y", `-${FILTER_REGION_MARGIN}`);
  filter.setAttribute("width", FILTER_REGION_SIZE);
  filter.setAttribute("height", FILTER_REGION_SIZE);
  filter.setAttribute("color-interpolation-filters", "sRGB");

  const turbulence = document.createElementNS(SVG_NS, "feTurbulence");
  turbulence.setAttribute("type", "fractalNoise");
  turbulence.setAttribute("baseFrequency", String(config.baseFrequency));
  turbulence.setAttribute("numOctaves",    String(config.numOctaves));
  turbulence.setAttribute("seed",          String(config.seed));
  turbulence.setAttribute("result",        "noise");

  if (config.animate && !reduceMotion) {
    turbulence.append(buildTurbulenceAnimation(config));
  }

  const displacement = document.createElementNS(SVG_NS, "feDisplacementMap");
  displacement.setAttribute("in",  "SourceGraphic");
  displacement.setAttribute("in2", "noise");
  displacement.setAttribute("scale", String(clampScale(config.scale)));
  // R and G channels give independent horizontal and vertical displacement.
  displacement.setAttribute("xChannelSelector", "R");
  displacement.setAttribute("yChannelSelector", "G");

  filter.append(turbulence, displacement);
  svgHost.append(filter);
  // Prepend so the filter is available before any painted element references it.
  document.body.prepend(svgHost);

  return filter;
}

/**
 * Updates parameters of an existing liquid-glass filter without removing it.
 * Returns `null` if no filter with the given `id` exists.
 *
 * @param {string} [id]
 * @param {import("../../src/index.d.ts").FilterOptions} [options]
 * @returns {SVGFilterElement | null}
 */
export function updateLiquidGlassFilter(id = FILTER_DEFAULTS.id, options = {}) {
  const filter = document.getElementById(id);
  if (!filter) return null;

  const turbulence   = filter.querySelector("feTurbulence");
  const displacement = filter.querySelector("feDisplacementMap");

  if (turbulence && options.baseFrequency !== undefined) {
    turbulence.setAttribute("baseFrequency", String(options.baseFrequency));
  }

  if (displacement && options.scale !== undefined) {
    displacement.setAttribute("scale", String(clampScale(options.scale)));
  }

  if (options.animate !== undefined) {
    setLiquidGlassMotion(id, Boolean(options.animate), options);
  }

  if (turbulence && options.duration !== undefined) {
    findTurbulenceAnimation(turbulence)?.setAttribute("dur", String(options.duration));
  }

  return filter;
}

/**
 * Enables or disables the animated baseFrequency oscillation on an existing
 * filter.  Disabling also resets baseFrequency to its resting value so the
 * static appearance stays consistent.
 *
 * @param {string} [id]
 * @param {boolean} [enabled]
 * @param {import("../../src/index.d.ts").MotionOptions} [options]
 * @returns {SVGFilterElement | null}
 */
export function setLiquidGlassMotion(id = FILTER_DEFAULTS.id, enabled = true, options = {}) {
  const filter     = document.getElementById(id);
  const turbulence = filter?.querySelector("feTurbulence");
  if (!turbulence) return null;

  const existingAnimation = findTurbulenceAnimation(turbulence);

  if (!enabled) {
    existingAnimation?.remove();
    // Restore resting frequency so static appearance matches the animated baseline.
    turbulence.setAttribute(
      "baseFrequency",
      String(options.baseFrequency ?? FILTER_DEFAULTS.baseFrequency)
    );
    return filter;
  }

  // Guard against duplicate <animate> elements.
  if (!existingAnimation) {
    turbulence.append(buildTurbulenceAnimation({ ...FILTER_DEFAULTS, ...options }));
  }

  return filter;
}
