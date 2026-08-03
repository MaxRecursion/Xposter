/** Minimum allowed feDisplacementMap scale value. */
export const SCALE_MIN = 0;

/** Maximum allowed feDisplacementMap scale value — visually safe upper bound. */
export const SCALE_MAX = 25;

/**
 * Ratio between the animation's peak baseFrequency and its resting value.
 * 1.65 was tuned to give a noticeable but not jarring ripple without exceeding
 * the range where noise becomes unrecognisably chaotic.
 */
export const FREQUENCY_PEAK_RATIO = 1.65;

/**
 * The SVG filter region is extended beyond 100% so that displaced pixels at
 * the element's edges are not clipped by the filter bounding box.
 * A ±20% margin (yielding 140% total) covers the worst-case displacement at
 * SCALE_MAX without wasting GPU memory on most configurations.
 */
export const FILTER_REGION_MARGIN = "20%";
export const FILTER_REGION_SIZE   = "140%";

/** Default ID written to the injected <filter> element. */
export const DEFAULT_FILTER_ID = "liquid-glass-filter";

/**
 * Safe clamp bounds for the tint fill opacity (--lg-opacity).
 * Widened from [0.12, 0.85] — that range clipped both ends of what users
 * actually want: near-invisible barely-there glass at the bottom, and a
 * fully opaque frosted card (no see-through content at all) at the top.
 */
export const OPACITY_MIN = 0.04;
export const OPACITY_MAX = 1;

/** Default oscillation period for the `.liquid-glass--pulse-*` transparency variants. */
export const PULSE_DURATION_DEFAULT = "6s";

/**
 * How far (in --lg-opacity units) the pulse animation swings from the
 * element's resting opacity. Subtle/vivid presets scale this multiplicatively.
 */
export const PULSE_AMPLITUDE_DEFAULT = 0.18;

/** Transition duration for `.liquid-glass--drag-only` switching between its flat and active states. */
export const DRAG_ONLY_TRANSITION = "0.25s";

/**
 * Named easing/duration pairs for how a window snaps back into shape after
 * a drag ends. "bouncy" is the original overshoot spring; "smooth" and
 * "snappy" are critically-damped (no overshoot) at different speeds, for
 * users who find the bounce-back too "spongy".
 */
export const DRAG_RETURN_PRESETS = {
  bouncy: { easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", duration: "0.5s" },
  smooth: { easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", duration: "0.45s" },
  snappy: { easing: "cubic-bezier(0.16, 1, 0.3, 1)",      duration: "0.28s" },
};
export const DRAG_RETURN_DEFAULT = "bouncy";

/** Velocity-driven refraction boost applied to the SVG displacement scale while actively dragging. */
export const DRAG_REFRACTION_BOOST = 3;

/** Default options used when a caller omits a field. */
export const FILTER_DEFAULTS = {
  id:            DEFAULT_FILTER_ID,
  baseFrequency: 0.008,
  numOctaves:    2,
  scale:         21,
  seed:          7,
  animate:       true,
  duration:      "7s",
};

/**
 * Single source of truth for every user-tunable range in the effect.
 * Consumers (the demo's Control Panel, or any other UI) should read
 * min/max/step/default from here instead of hard-coding their own numbers,
 * so the library's configurable surface can be widened/narrowed in one
 * place and stays consistent everywhere it's rendered.
 */
export const LIQUID_GLASS_LIMITS = {
  blur:           { min: 0,   max: 40,  step: 1,    default: 8 },
  refraction:     { min: SCALE_MIN, max: SCALE_MAX, step: 1, default: FILTER_DEFAULTS.scale },
  saturate:       { min: 60,  max: 300, step: 5,    default: 180 },
  // Old v0.1.0 demo read as noticeably more transparent than the current
  // default (58) — lowering the default (and every preset's opacity below)
  // brings back that lighter, less-opaque glass look without reviving any
  // other part of the old demo.
  opacity:        { min: Math.round(OPACITY_MIN * 100), max: Math.round(OPACITY_MAX * 100), step: 1, default: 38 },
  // Defaults mirror demo/src/utils/dragMath.js's DRAG_SKEW_STRENGTH /
  // DRAG_CORNER_PULL_STRENGTH so the slider starts where the drag feel
  // actually starts (that file can't be imported from here — it's demo-only
  // and depends on no DOM/React, kept duplicated intentionally, in sync).
  dragSkew:            { min: 0, max: 1,    step: 0.02,   default: 0.16 },
  dragCornerPull:      { min: 0, max: 1,    step: 0.02,   default: 0.18 },
  dragScaleSensitivity: { min: 0, max: 0.002, step: 0.0001, default: 0.0004 },
  dragScaleMax:         { min: 1, max: 1.2,   step: 0.01,   default: 1.02 },
};

/**
 * Named combinations of the tunables above. "vivid"/"subtle"/"vision" mirror
 * the original v0.1.0 demo's presets; selecting one should drive every
 * slider at once rather than just relabelling the UI. Opacity values are
 * kept low (lighter glass) to match the old demo's more transparent look.
 */
export const PRESETS = {
  vivid:  { blur: 8,  refraction: 21, saturate: 200, opacity: 40 },
  subtle: { blur: 14, refraction: 10, saturate: 140, opacity: 28 },
  vision: { blur: 22, refraction: 6,  saturate: 120, opacity: 22 },
};
export const PRESET_DEFAULT = "vivid";

/**
 * Named intensities for the drag-time "liquid" distortion (skew + corner
 * pull + scale, layered together — see demo/src/utils/dragMath.js). Rather
 * than tune one strength slider, this gives named "types" of squish, from
 * off to the original, more pronounced "rubbery" stretch some users want
 * back deliberately, and everything is still fine-tunable afterward via the
 * individual sliders (selecting a level just sets their starting point).
 * scaleSensitivity/scaleMax mirror DRAG_SCALE_SENSITIVITY/DRAG_SCALE_MAX in
 * dragMath.js and are read the same way skew/cornerPull already are — via
 * --drag-* CSS custom properties set by the demo, with those constants as
 * the fallback when a consumer hasn't configured them.
 */
export const DRAG_DISTORTION_PRESETS = {
  none:    { skew: 0,    cornerPull: 0,    scaleSensitivity: 0,      scaleMax: 1 },
  subtle:  { skew: 0.16, cornerPull: 0.18, scaleSensitivity: 0.0004, scaleMax: 1.02 },
  elastic: { skew: 0.28, cornerPull: 0.3,  scaleSensitivity: 0.0008, scaleMax: 1.06 },
  wild:    { skew: 0.42, cornerPull: 0.42, scaleSensitivity: 0.0014, scaleMax: 1.12 },
};
export const DRAG_DISTORTION_DEFAULT = "subtle";
