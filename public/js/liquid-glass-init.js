import { injectLiquidGlassFilter } from '/vendor/liquid-glass/inject-filter.js';

/** SVG displacement filter — live backdrop refraction in Chromium, sprite fallback in Safari. */
injectLiquidGlassFilter({
  id: 'liquid-glass-filter',
  baseFrequency: 0.006,
  numOctaves: 2,
  scale: 14,
  seed: 7,
  animate: true,
  duration: '9s',
});

/** Scene background for Safari refraction sprite — mirrors ambient orbs behind the sidebar. */
function syncSidebarSceneBackground() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const base = getComputedStyle(document.documentElement).getPropertyValue('--lg-bg-base').trim();
  const a1 = getComputedStyle(document.documentElement).getPropertyValue('--lg-bg-ambient-1').trim();
  const a2 = getComputedStyle(document.documentElement).getPropertyValue('--lg-bg-ambient-2').trim();
  const a3 = getComputedStyle(document.documentElement).getPropertyValue('--lg-bg-ambient-3').trim();
  const scene = [
    `radial-gradient(circle at 8% 12%, ${a1}, transparent 42%)`,
    `radial-gradient(circle at 92% 78%, ${a3}, transparent 45%)`,
    `radial-gradient(circle at 70% 20%, ${a2}, transparent 38%)`,
    base || (theme === 'light' ? '#e8e8ed' : '#0c0c0e'),
  ].join(', ');
  document.documentElement.style.setProperty('--lg-scene-background', scene);
}

syncSidebarSceneBackground();
document.addEventListener('xposter:theme', syncSidebarSceneBackground);
