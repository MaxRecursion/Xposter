#!/usr/bin/env python3
"""Prepends Liquid Glass tokens and patches liquid-glass.css from styles patterns."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "public" / "liquid-glass.css"

TOKENS = r'''/* ═══════════════════════════════════════════════════════════════════════════
   Xposter — Liquid Glass design system (macOS 26 / iOS 26)
   Glass on CHROME only. Content surfaces are opaque. Single self-contained file.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── DESIGN TOKENS (retheme here) ─────────────────────────────────────────── */
:root {
  /* Spring physics — stiffness 300, damping 30, mass 1 */
  --lg-spring-stiffness: 300;
  --lg-spring-damping: 30;
  --lg-spring-mass: 1;
  --lg-spring-duration: 380ms;
  --lg-spring-bezier: linear(
    0, 0.002, 0.01 3.6%, 0.035 7.2%, 0.129 17.4%, 0.538 38.9%,
    0.703 48.4%, 0.795 55.7%, 0.869 63.4%, 0.925 71.6%,
    0.968 80.3%, 0.992 90.2%, 1
  );

  /* Glass blur & saturation */
  --lg-glass-blur: 28px;
  --lg-glass-saturate: 180%;
  --lg-glass-clear-blur: 14px;
  --lg-glass-clear-saturate: 160%;
  --lg-scrim-alpha: 0.42;

  /* Concentric radius scale — inner = outer − padding */
  --lg-radius-xl: 20px;
  --lg-radius-lg: 16px;
  --lg-radius-md: 12px;
  --lg-radius-sm: 10px;
  --lg-radius-xs: 8px;
  --lg-pad-xl: 16px;
  --lg-pad-lg: 12px;
  --lg-pad-md: 10px;
  --lg-pad-sm: 8px;
  --lg-radius-inner-xl: calc(var(--lg-radius-xl) - var(--lg-pad-xl));
  --lg-radius-inner-lg: calc(var(--lg-radius-lg) - var(--lg-pad-lg));
  --lg-radius-inner-md: calc(var(--lg-radius-md) - var(--lg-pad-md));
  --lg-radius-inner-sm: calc(var(--lg-radius-sm) - var(--lg-pad-sm));

  /* Specular edge */
  --lg-specular-opacity: 0.62;
  --lg-specular-fade: 0.08;
  --lg-specular-x: 14%;
  --lg-specular-y: 10%;

  /* Edge lensing (perimeter distortion fake) */
  --lg-lens-inset-light: rgba(255, 255, 255, 0.14);
  --lg-lens-inset-dark: rgba(0, 0, 0, 0.22);
  --lg-lens-spread: 8px;

  /* Layout */
  --lg-sidebar-w: 252px;
  --lg-topbar-h: 52px;
  --lg-nav-stagger: 25ms;

  /* Accent (brand) */
  --lg-accent: #ff9e21;
  --lg-accent-dim: #e8870d;
  --lg-accent-on: #1a1208;

  /* Semantic */
  --lg-green: #30d158;
  --lg-red: #ff453a;
  --lg-orange: #ff9f0a;
  --lg-yellow: #ffd60a;
}

[data-theme='dark'] {
  --lg-bg-base: #0c0c0e;
  --lg-bg-ambient-1: rgba(255, 158, 33, 0.22);
  --lg-bg-ambient-2: rgba(80, 200, 120, 0.12);
  --lg-bg-ambient-3: rgba(120, 140, 180, 0.1);
  --lg-glass-tint: color-mix(in srgb, #1c1c1e 58%, transparent);
  --lg-glass-tint-hover: color-mix(in srgb, #2a2a2e 64%, transparent);
  --lg-glass-clear-tint: color-mix(in srgb, #141416 48%, transparent);
  --lg-content-bg: #161618;
  --lg-content-bg-elevated: #1c1c1e;
  --lg-content-border: rgba(255, 255, 255, 0.09);
  --lg-content-border-strong: rgba(255, 255, 255, 0.14);
  --lg-text-primary: #f5f5f7;
  --lg-text-secondary: #a1a1a6;
  --lg-text-tertiary: #6e6e73;
  --lg-focus-ring: rgba(255, 158, 33, 0.45);
  --lg-code-bg: #0a0a0c;
}

[data-theme='light'] {
  --lg-bg-base: #e8e8ed;
  --lg-bg-ambient-1: rgba(255, 158, 33, 0.18);
  --lg-bg-ambient-2: rgba(52, 199, 89, 0.12);
  --lg-bg-ambient-3: rgba(100, 120, 160, 0.08);
  --lg-glass-tint: color-mix(in srgb, #f2f2f7 72%, transparent);
  --lg-glass-tint-hover: color-mix(in srgb, #ffffff 78%, transparent);
  --lg-glass-clear-tint: color-mix(in srgb, #f8f8fa 55%, transparent);
  --lg-content-bg: #ffffff;
  --lg-content-bg-elevated: #f5f5f7;
  --lg-content-border: rgba(0, 0, 0, 0.08);
  --lg-content-border-strong: rgba(0, 0, 0, 0.12);
  --lg-text-primary: #1d1d1f;
  --lg-text-secondary: #6e6e73;
  --lg-text-tertiary: #86868b;
  --lg-focus-ring: rgba(217, 119, 6, 0.4);
  --lg-code-bg: #f5f5f7;
}

/* Map legacy token aliases used by app.js inline styles */
:root, [data-theme='dark'], [data-theme='light'] {
  --bg: var(--lg-bg-base);
  --bg-elevated: var(--lg-content-bg-elevated);
  --surface: var(--lg-content-bg);
  --surface2: var(--lg-content-bg-elevated);
  --surface-solid: var(--lg-content-bg);
  --border: var(--lg-content-border);
  --border-strong: var(--lg-content-border-strong);
  --text: var(--lg-text-primary);
  --text1: var(--lg-text-primary);
  --text2: var(--lg-text-secondary);
  --text3: var(--lg-text-tertiary);
  --accent: var(--lg-accent);
  --accent-dim: var(--lg-accent-dim);
  --accent-glow: color-mix(in srgb, var(--lg-accent) 35%, transparent);
  --green: var(--lg-green);
  --red: var(--lg-red);
  --orange: var(--lg-orange);
  --yellow: var(--lg-yellow);
  --header-bg: transparent;
  --shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  --shadow-sm: 0 2px 10px rgba(0, 0, 0, 0.1);
  --card: var(--lg-content-bg);
  --card-bg: var(--lg-content-bg);
  --code-bg: var(--lg-code-bg);
  --error: var(--lg-red);
  --radius: var(--lg-radius-lg);
  --radius-sm: var(--lg-radius-sm);
  --radius-xs: var(--lg-radius-xs);
  --sidebar-w: var(--lg-sidebar-w);
  --topbar-h: var(--lg-topbar-h);
  --ease-spring: var(--lg-spring-bezier);
  --ease-out: var(--lg-spring-bezier);
  --glass: none;
}

/* ── Liquid Glass chrome layer (sidebar, toolbar, popovers, floating controls) */
.lg-chrome,
.sidebar,
.topbar,
.toast,
.icon-btn {
  position: relative;
  isolation: isolate;
  background: var(--lg-glass-tint);
  -webkit-backdrop-filter: blur(var(--lg-glass-blur)) saturate(var(--lg-glass-saturate));
  backdrop-filter: blur(var(--lg-glass-blur)) saturate(var(--lg-glass-saturate));
  transition:
    background var(--lg-spring-duration) var(--lg-spring-bezier),
    transform var(--lg-spring-duration) var(--lg-spring-bezier);
}

.lg-chrome::before,
.sidebar::before,
.topbar::before,
.toast::before,
.icon-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  pointer-events: none;
  z-index: 2;
  background: conic-gradient(
    from 225deg at var(--lg-specular-x) var(--lg-specular-y),
    rgba(255, 255, 255, calc(var(--lg-specular-opacity) * 0.95)) 0deg,
    rgba(255, 255, 255, var(--lg-specular-fade)) 80deg,
    rgba(255, 255, 255, 0.03) 180deg,
    rgba(255, 255, 255, 0.12) 270deg,
    rgba(255, 255, 255, calc(var(--lg-specular-opacity) * 0.5)) 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}

.lg-chrome::after,
.sidebar::after,
.topbar::after,
.toast::after,
.icon-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  box-shadow:
    inset 0 1px 1px var(--lg-lens-inset-light),
    inset 1px 0 2px rgba(255, 255, 255, 0.06),
    inset 0 -var(--lg-lens-spread) var(--lg-lens-spread) var(--lg-lens-inset-dark),
    inset -4px 0 8px rgba(0, 0, 0, 0.06);
}

.lg-chrome:hover,
.sidebar:hover,
.topbar:hover,
.icon-btn:hover {
  background: var(--lg-glass-tint-hover);
}

/* Clear glass + scrim (mobile sidebar overlay) */
.sidebar-overlay {
  background: rgba(0, 0, 0, var(--lg-scrim-alpha));
  -webkit-backdrop-filter: blur(var(--lg-glass-clear-blur)) saturate(var(--lg-glass-clear-saturate));
  backdrop-filter: blur(var(--lg-glass-clear-blur)) saturate(var(--lg-glass-clear-saturate));
}

/* Focus — glass ring, not browser outline */
:focus-visible {
  outline: none;
}
:focus-visible {
  box-shadow: 0 0 0 2px var(--lg-focus-ring), 0 0 0 4px color-mix(in srgb, var(--lg-focus-ring) 35%, transparent);
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .lg-chrome, .sidebar, .topbar, .toast, .icon-btn {
    background: var(--lg-content-bg-elevated);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .lg-chrome, .sidebar, .topbar, .toast, .icon-btn, .sidebar-overlay {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    background: var(--lg-content-bg-elevated) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Nav selection capsule — slides between sidebar rows */
.sidebar-nav { position: relative; }
.nav-selection-capsule {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 0;
  border-radius: var(--lg-radius-inner-sm);
  background: color-mix(in srgb, var(--lg-accent) 16%, var(--lg-content-bg-elevated));
  border: 1px solid color-mix(in srgb, var(--lg-accent) 28%, transparent);
  pointer-events: none;
  will-change: transform, width, height;
  transition:
    transform var(--lg-spring-duration) var(--lg-spring-bezier),
    width var(--lg-spring-duration) var(--lg-spring-bezier),
    height var(--lg-spring-duration) var(--lg-spring-bezier);
}
.nav-item {
  z-index: 1;
  border-radius: var(--lg-radius-sm);
  transition: color var(--lg-spring-duration) var(--lg-spring-bezier),
    transform var(--lg-spring-duration) var(--lg-spring-bezier);
}
.nav-item::before { display: none !important; }
.nav-item:hover { transform: scale(1.02); background: transparent !important; border-color: transparent !important; }
.nav-item.active {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
  color: var(--lg-text-primary);
}
.nav-item:active { transform: scale(0.97); }

/* Sidebar collapse stagger */
.app-shell.sidebar-collapsed .nav-label,
.app-shell.sidebar-collapsed .nav-badge,
.app-shell.sidebar-collapsed .nav-group-label,
.app-shell.sidebar-collapsed .brand-copy {
  opacity: 0;
  transform: translateX(-8px);
  transition:
    opacity var(--lg-spring-duration) var(--lg-spring-bezier),
    transform var(--lg-spring-duration) var(--lg-spring-bezier);
}
.app-shell .nav-label,
.app-shell .nav-badge,
.app-shell .nav-group-label,
.app-shell .brand-copy {
  transition:
    opacity var(--lg-spring-duration) var(--lg-spring-bezier),
    transform var(--lg-spring-duration) var(--lg-spring-bezier);
}
.app-shell .nav-group:nth-child(1) .nav-label { transition-delay: 0ms; }
.app-shell .nav-group:nth-child(2) .nav-label { transition-delay: var(--lg-nav-stagger); }
.app-shell .nav-group:nth-child(3) .nav-label { transition-delay: calc(var(--lg-nav-stagger) * 2); }
.app-shell .nav-group:nth-child(4) .nav-label { transition-delay: calc(var(--lg-nav-stagger) * 3); }
.app-shell .nav-group:nth-child(5) .nav-label { transition-delay: calc(var(--lg-nav-stagger) * 4); }

'''

CHROME_ONLY = {
    '.sidebar', '.topbar', '.toast', '.icon-btn', '.sidebar-overlay',
}

CONTENT_PREFIXES = (
    '.stat-card', '.post-card', '.settings-card', '.analytics-card',
    '.analytics-summary-card', '.account-card', '.follower-card',
    '.schedule-strip', '.sync-status', '.diag-table', '.audience-card',
    '.agent-card', '.rag-card', '.rag-stat-card', '.memory-graph-panel',
    '.mem-card', '.original-post-card', '.empty-state',
)

def main():
    body = CSS.read_text()
    # Remove old design tokens block (first ~65 lines until ambient-bg)
    start = body.find('.ambient-bg')
    if start > 0:
        body = body[start:]

    # Strip backdrop-filter from content surfaces in bulk
    lines = body.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        # Detect rule start
        if stripped.endswith('{') and not stripped.startswith('@'):
            selector = stripped[:-1].strip()
            is_content = any(selector.startswith(p) or selector == p[1:] for p in CONTENT_PREFIXES)
            is_chrome = any(selector.startswith(c) or selector == c[1:] for c in CHROME_ONLY)
            block = [line]
            i += 1
            while i < len(lines) and lines[i].strip() != '}':
                prop = lines[i]
                if is_content and ('backdrop-filter' in prop or '-webkit-backdrop-filter' in prop):
                    i += 1
                    continue
                if is_content and 'background: var(--surface)' in prop:
                    prop = prop.replace('var(--surface)', 'var(--lg-content-bg)')
                block.append(prop)
                i += 1
            if i < len(lines):
                block.append(lines[i])
            out.extend(block)
        else:
            out.append(line)
        i += 1

    body = '\n'.join(out)

    # Patch sidebar - remove old border-right conflict
    body = body.replace(
        'border-right: 1px solid var(--border);',
        'border-right: none;',
        1,
    )
    body = body.replace(
        'border-bottom: 1px solid var(--border);',
        'border-bottom: none;',
        1,
    )

    # Replace fade animations with morph springs
    body = body.replace(
        '@keyframes panelIn {\n  from { opacity: 0; transform: translateY(12px); }\n  to { opacity: 1; transform: translateY(0); }\n}',
        '@keyframes panelIn {\n  from { transform: scale(0.97) translateY(6px); }\n  to { transform: scale(1) translateY(0); }\n}',
    )
    body = body.replace(
        '@keyframes cardIn {\n  from { opacity: 0; transform: translateY(16px) scale(0.98); }\n  to { opacity: 1; transform: translateY(0) scale(1); }\n}',
        '@keyframes cardIn {\n  from { transform: translateY(10px) scale(0.97); }\n  to { transform: translateY(0) scale(1); }\n}',
    )
    body = body.replace(
        '@keyframes fadeIn {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}',
        '@keyframes fadeIn {\n  from { transform: scale(0.99); }\n  to { transform: scale(1); }\n}',
    )
    body = body.replace('animation: fadeIn 0.6s var(--ease-out);', '')
    body = body.replace('transition: background 0.35s var(--ease-out), color 0.35s var(--ease-out);', '')

    # Tab morph
    body = body.replace(
        '.tab-content.active {\n  display: block;\n  animation: panelIn 0.4s var(--ease-out) forwards;\n}',
        '.tab-content.active {\n  display: block;\n  animation: panelIn var(--lg-spring-duration) var(--lg-spring-bezier) forwards;\n}',
    )

    # Topbar unified with title bar
    body = body.replace(
        'height: var(--topbar-h);',
        'height: var(--lg-topbar-h); min-height: var(--lg-topbar-h);',
        1,
    )

    # Content cards opaque solid
    body = body.replace(
        'background: var(--surface);\n  backdrop-filter: var(--glass);',
        'background: var(--lg-content-bg);',
    )

    CSS.write_text(TOKENS + body)
    print(f'Wrote {CSS} ({CSS.stat().st_size} bytes)')

if __name__ == '__main__':
    main()
