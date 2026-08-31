import { getBrowserContext, runExclusive } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

/**
 * Scrapes the "Active times" heatmap from x.com/i/account_analytics/audience.
 *
 * X renders a 7×24 grid of colored cells (columns = days Mo→Su, rows = hours).
 * Previously this used SVG <rect> elements; X has since switched to HTML divs
 * with CSS background colors. We detect cells by computed background color and
 * getBoundingClientRect positions, with the original SVG strategy as fallback.
 */

export interface AudienceScrapeResult {
  ok: boolean;
  matrix?: number[][];     // [dayOfWeek 0=Sun][hour 0..23] = intensity 0..1
  levels?: number[][];     // [dayOfWeek][hour] = bucket 0..4
  cellCount?: number;
  error?: string;
  /**
   * X served the Premium upsell instead of the analytics page. Distinct from a
   * scrape failure: no selector work can recover it, and retrying on a daily
   * timer only burns a browser page. Callers use this to stand the job down.
   */
  premiumRequired?: boolean;
}

export async function scrapeAudienceHeatmap(): Promise<AudienceScrapeResult> {
  return runExclusive(() => scrapeAudienceHeatmapImpl());
}

async function scrapeAudienceHeatmapImpl(): Promise<AudienceScrapeResult> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    logger.info('Audience scrape: navigating to analytics audience page');
    await page.goto('https://x.com/i/account_analytics/audience', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });

    // Wait for the "Active times" heading to appear
    try {
      await page.waitForFunction(
        () => {
          const els = Array.from(document.querySelectorAll('*'));
          return els.some((el) =>
            /\bactive\s+times\b/i.test(el.textContent ?? '') &&
            (el as HTMLElement).offsetParent !== null,
          );
        },
        { timeout: 25_000 },
      );
    } catch {
      logger.warn('Audience: "Active times" heading did not appear in time');
    }

    // Scroll down then back — some analytics cards lazy-render on visibility.
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(randomBetween(800, 1400));
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch { /* non-fatal */ }

    // Let any final animations settle
    await delay(randomBetween(1500, 2500));

    // Check for the subscription gate before parsing. X shows an "Advanced
    // analytics with X Premium … Upgrade to continue" dialog over a blurred
    // preview, so the heatmap is genuinely absent from the DOM rather than
    // merely behind a selector we got wrong.
    const paywalled = await page.evaluate(() => {
      const body = (document.body?.innerText ?? '').toLowerCase();
      return /advanced analytics with x premium/.test(body)
        || (/upgrade to continue/.test(body) && /analytics/.test(body));
    }).catch(() => false);

    if (paywalled) {
      logger.warn('Audience analytics is gated behind X Premium for this account');
      return { ok: false, error: 'premium_required', premiumRequired: true };
    }

    const data = await page.evaluate(() => {
      // ── Colour helpers ─────────────────────────────────────────────────────
      const parseRgb = (s: string): [number, number, number] | null => {
        if (!s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return null;
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
        if (parts.length < 3) return null;
        return [parts[0], parts[1], parts[2]];
      };
      const luminance = ([r, g, b]: [number, number, number]) =>
        0.2126 * r + 0.7152 * g + 0.0722 * b;

      // Round to nearest bucket to absorb sub-pixel jitter
      const snap = (n: number, eps = 3) => Math.round(n / eps) * eps;

      // ── Strategy 1: HTML element grid (current X rendering) ───────────────
      // Find "Active times" heading then walk up to its card container.
      const headerPat = /\bactive\s+times\b/i;
      let header: Element | null = null;
      for (const el of Array.from(document.querySelectorAll('span,div,p,h1,h2,h3,h4,h5,h6'))) {
        if (
          headerPat.test((el as HTMLElement).innerText ?? el.textContent ?? '') &&
          (el.children.length < 4) &&
          (el as HTMLElement).offsetParent !== null
        ) {
          header = el;
          break;
        }
      }

      if (header) {
        // Walk up until we find a container big enough to hold the whole chart
        let container: Element | null = header;
        for (let i = 0; i < 12; i++) {
          const next: Element | null = container?.parentElement ?? null;
          if (!next) break;
          const r = next.getBoundingClientRect();
          if (r.width > 250 && r.height > 200) { container = next; break; }
          container = next;
        }

        if (container) {
          // Collect all small elements inside the container that have a
          // non-transparent, non-white computed background colour.
          const candidates = Array.from(container.querySelectorAll('*'))
            .map((el) => {
              const style = window.getComputedStyle(el);
              const bg = style.backgroundColor;
              const rgb = parseRgb(bg);
              if (!rgb) return null;
              const [r, g, b] = rgb;
              // Reject white/near-white and very dark (UI chrome)
              const lum = luminance([r, g, b]);
              if (lum > 245 || lum < 5) return null;
              const rect = el.getBoundingClientRect();
              // Accept cells in the plausible size range for a heatmap cell
              if (rect.width < 4 || rect.height < 4) return null;
              if (rect.width > 60 || rect.height > 60) return null;
              return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, lum, bg };
            })
            .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number; lum: number; bg: string }>;

          if (candidates.length >= 100) {
            // Dedupe by snapped position (multiple DOM elements can overlap)
            const seen = new Set<string>();
            const cells = candidates.filter((c) => {
              const key = `${snap(c.x)},${snap(c.y)}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });

            if (cells.length >= 100) {
              // Discover column (x→day) and row (y→hour) buckets
              const xSnapped = new Set(cells.map((c) => snap(c.x)));
              const ySnapped = new Set(cells.map((c) => snap(c.y)));
              const xs = Array.from(xSnapped).sort((a, b) => a - b);
              const ys = Array.from(ySnapped).sort((a, b) => a - b);

              if (xs.length >= 5 && ys.length >= 20) {
                // Try to read day-of-week labels from text nodes near the bottom
                // of the container. X shows Mo, Tu, We, Th, Fr, Sa, Su.
                const dayMap: Record<string, number> = {
                  su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
                };
                const labelPositions: Array<{ x: number; dow: number }> = [];
                for (const el of Array.from(container.querySelectorAll('span,div,p'))) {
                  const txt = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().toLowerCase();
                  if (/^(su|mo|tu|we|th|fr|sa)$/.test(txt)) {
                    const r = el.getBoundingClientRect();
                    const dow = dayMap[txt];
                    if (dow !== undefined) labelPositions.push({ x: r.left + r.width / 2, dow });
                  }
                }

                const xToDow: Record<number, number> = {};
                if (labelPositions.length >= 5) {
                  for (const x of xs) {
                    let best = labelPositions[0];
                    let bestDist = Math.abs(labelPositions[0].x - x);
                    for (const lp of labelPositions) {
                      const d = Math.abs(lp.x - x);
                      if (d < bestDist) { bestDist = d; best = lp; }
                    }
                    xToDow[x] = best.dow;
                  }
                } else {
                  // Fallback: left→right = Mo, Tu, We, Th, Fr, Sa, Su
                  const order = [1, 2, 3, 4, 5, 6, 0];
                  xs.forEach((x, i) => { xToDow[x] = order[i] ?? 0; });
                }

                const yToHour: Record<number, number> = {};
                ys.forEach((y, i) => { yToHour[y] = i; });

                const minL = Math.min(...cells.map((c) => c.lum));
                const maxL = Math.max(...cells.map((c) => c.lum));
                const range = Math.max(1, maxL - minL);

                const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
                const levels: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
                let filled = 0;

                for (const c of cells) {
                  const sx = snap(c.x), sy = snap(c.y);
                  const dow = xToDow[sx];
                  const hour = yToHour[sy];
                  if (dow == null || hour == null || hour >= 24) continue;
                  // Darker = more engaged → invert normalised luminance
                  const intensity = Math.max(0, Math.min(1, 1 - (c.lum - minL) / range));
                  matrix[dow][hour] = intensity;
                  levels[dow][hour] = Math.min(4, Math.floor(intensity * 5));
                  filled++;
                }

                if (filled >= 100) {
                  return { matrix, levels, cellCount: filled, strategy: 'HTML-divs' };
                }
              }
            }
          }
        }
      }

      // ── Strategy 2: SVG <rect> fallback (legacy X rendering) ─────────────
      const bucket = (n: number, eps = 2) => Math.round(n / eps) * eps;

      const allSvg = Array.from(document.querySelectorAll('svg')) as SVGSVGElement[];

      let heatmapSvg: SVGSVGElement | null = null;
      let strategyUsed = '';

      // Strategy A — rect count in plausible band
      const candidates2 = allSvg
        .map((svg) => ({ svg, n: svg.querySelectorAll('rect').length }))
        .filter(({ n }) => n >= 100 && n <= 400)
        .sort((a, b) => Math.abs(168 - a.n) - Math.abs(168 - b.n));
      if (candidates2.length > 0) {
        heatmapSvg = candidates2[0].svg;
        strategyUsed = `SVG-A(rects=${candidates2[0].n})`;
      }

      // Strategy B — anchor on heading, walk up to nearest SVG
      if (!heatmapSvg) {
        const headerPattern = /\b(active\s+times|most\s+active|audience\s+activity)\b/i;
        const header2 = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,span,div'))
          .find((el) => headerPattern.test(el.textContent ?? ''));
        if (header2) {
          let p: Element | null = header2;
          for (let i = 0; i < 10 && p && !heatmapSvg; i++) {
            for (const svg of Array.from(p.querySelectorAll?.('svg') ?? [])) {
              if (svg.querySelectorAll('rect').length >= 50) {
                heatmapSvg = svg as SVGSVGElement;
                strategyUsed = `SVG-B(rects=${heatmapSvg.querySelectorAll('rect').length})`;
                break;
              }
            }
            p = p.parentElement;
          }
        }
      }

      if (!heatmapSvg) {
        // Collect diagnostics
        const inventory = allSvg.slice(0, 20).map((svg) => ({
          rects: svg.querySelectorAll('rect').length,
          paths: svg.querySelectorAll('path').length,
          texts: Array.from(svg.querySelectorAll('text')).slice(0, 6)
            .map((t) => (t.textContent ?? '').trim()).filter(Boolean),
        }));
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
          .slice(0, 20).map((h) => (h.textContent ?? '').trim()).filter(Boolean);
        const activeTimesEl = Array.from(document.querySelectorAll('*')).find(
          (el) => /\bactive\s+times\b/i.test((el as HTMLElement).innerText ?? el.textContent ?? ''),
        );
        return {
          error: 'heatmap not found (tried HTML-divs + SVG)',
          debug: {
            svgCount: allSvg.length,
            inventory,
            headings,
            activeTimesFound: !!activeTimesEl,
            activeTimesTag: activeTimesEl?.tagName,
          },
        };
      }

      // Extract from SVG rects (original logic)
      const rects = Array.from(heatmapSvg.querySelectorAll('rect')) as SVGRectElement[];
      const cells2 = rects.map((r) => {
        const x = parseFloat(r.getAttribute('x') ?? '0');
        const y = parseFloat(r.getAttribute('y') ?? '0');
        const w = parseFloat(r.getAttribute('width') ?? '0');
        const h = parseFloat(r.getAttribute('height') ?? '0');
        let fill = r.getAttribute('fill') ?? '';
        if (!fill || fill === 'none' || fill === 'transparent') {
          fill = (getComputedStyle(r).fill ?? '').toString();
        }
        return { x, y, w, h, fill };
      }).filter((c) => c.w > 0 && c.h > 0 && c.w < 200 && c.h < 200 &&
        c.fill && c.fill !== 'none' && c.fill !== 'transparent');

      if (cells2.length < 100) {
        return { error: `SVG fallback: only ${cells2.length} cells found` };
      }

      const xSet = new Set<number>(); const ySet = new Set<number>();
      for (const c of cells2) { xSet.add(bucket(c.x)); ySet.add(bucket(c.y)); }
      const xs2 = Array.from(xSet).sort((a, b) => a - b);
      const ys2 = Array.from(ySet).sort((a, b) => a - b);

      const xToDow2: Record<number, number> = {};
      const texts = Array.from(heatmapSvg.querySelectorAll('text'));
      const dayMap2: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
      const labelPos2: Array<{ x: number; dow: number }> = [];
      for (const t of texts) {
        const txt = (t.textContent ?? '').trim();
        if (/^(Su|Mo|Tu|We|Th|Fr|Sa)$/i.test(txt)) {
          const key = txt.charAt(0).toUpperCase() + txt.charAt(1).toLowerCase();
          if (dayMap2[key] !== undefined) {
            labelPos2.push({ x: parseFloat(t.getAttribute('x') ?? '0'), dow: dayMap2[key] });
          }
        }
      }
      if (labelPos2.length >= 5) {
        for (const x of xs2) {
          let best = labelPos2[0]; let bestDist = Math.abs(labelPos2[0].x - x);
          for (const lp of labelPos2) { const d = Math.abs(lp.x - x); if (d < bestDist) { bestDist = d; best = lp; } }
          xToDow2[x] = best.dow;
        }
      } else {
        const order = [1, 2, 3, 4, 5, 6, 0];
        xs2.forEach((x, i) => { xToDow2[x] = order[i] ?? 0; });
      }
      const yToHour2: Record<number, number> = {};
      ys2.forEach((y, i) => { yToHour2[y] = i; });

      const cellByPos: Record<string, { l: number }> = {};
      const lums2: number[] = [];
      for (const c of cells2) {
        const xr = bucket(c.x), yr = bucket(c.y);
        const rgb = parseRgb(c.fill);
        if (!rgb) continue;
        const l = luminance(rgb);
        cellByPos[`${xr},${yr}`] = { l };
        lums2.push(l);
      }
      const minL2 = Math.min(...lums2); const maxL2 = Math.max(...lums2);
      const range2 = Math.max(1, maxL2 - minL2);

      const matrix2: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      const levels2: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      let filled2 = 0;
      for (const x of xs2) {
        for (const y of ys2) {
          const cell = cellByPos[`${x},${y}`];
          if (!cell) continue;
          const dow = xToDow2[x]; const hour = yToHour2[y];
          if (dow == null || hour == null) continue;
          const intensity = Math.max(0, Math.min(1, 1 - (cell.l - minL2) / range2));
          matrix2[dow][hour] = intensity;
          levels2[dow][hour] = Math.min(4, Math.floor(intensity * 5));
          filled2++;
        }
      }

      return { matrix: matrix2, levels: levels2, cellCount: filled2, strategy: strategyUsed };
    });

    if ('error' in data && data.error) {
      const debug = (data as { debug?: unknown }).debug;
      if (debug) {
        logger.warn('Audience scrape diagnostic', { error: data.error, debug });
        try {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const dir = path.resolve(process.cwd(), 'logs');
          await fs.mkdir(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const png = path.join(dir, `audience-debug-${stamp}.png`);
          await page.screenshot({ path: png, fullPage: true });
          logger.warn('Audience debug screenshot saved', { path: png });
        } catch (e) {
          logger.warn('Audience debug screenshot failed', { err: String(e) });
        }
      }
      return { ok: false, error: (data as { error: string }).error };
    }

    const ok = data as { matrix: number[][]; levels: number[][]; cellCount: number; strategy?: string };
    if (ok.strategy) logger.info('Audience heatmap detected', { strategy: ok.strategy });
    return { ok: true, matrix: ok.matrix, levels: ok.levels, cellCount: ok.cellCount };

  } catch (err) {
    logger.warn('Audience scrape threw', { err: String(err) });
    return { ok: false, error: String(err) };
  } finally {
    await page.close();
  }
}
