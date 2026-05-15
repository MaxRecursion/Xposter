import { getBrowserContext } from './session.js';
import { logger } from '../utils/logger.js';
import { delay, randomBetween } from '../utils/delay.js';

/**
 * Scrapes the "Active times" heatmap from x.com/i/account_analytics/audience.
 *
 * X renders a 7×24 SVG grid: columns = days (Mo→Su), rows = hours (12am→11pm).
 * Each <rect> is filled with one of five blue shades — lightest = least engaged,
 * darkest = most engaged. We bucket cells by perceived luminance and normalize
 * to a 0..1 intensity per cell. Output is a 7×24 matrix indexed [dayOfWeek][hour]
 * with dayOfWeek 0=Sunday (Date.getDay() convention).
 *
 * Requires X Premium / Analytics access on the logged-in account.
 */

export interface AudienceScrapeResult {
  ok: boolean;
  matrix?: number[][];     // [dayOfWeek 0=Sun][hour 0..23] = intensity 0..1
  levels?: number[][];     // [dayOfWeek][hour] = bucket 0..4
  cellCount?: number;
  error?: string;
}

export async function scrapeAudienceHeatmap(): Promise<AudienceScrapeResult> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();

  try {
    logger.info('Audience scrape: navigating to analytics audience page');
    await page.goto('https://x.com/i/account_analytics/audience', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });

    // Wait for the heatmap grid to render. The card has ~168 rects.
    try {
      await page.waitForFunction(
        () => {
          const allSvg = Array.from(document.querySelectorAll('svg'));
          return allSvg.some((svg) => {
            const n = svg.querySelectorAll('rect').length;
            return n >= 140 && n <= 220;
          });
        },
        { timeout: 25_000 },
      );
    } catch {
      logger.warn('Audience heatmap rects did not appear in time');
    }

    // Settle for any final animations
    await delay(randomBetween(1500, 2500));

    const data = await page.evaluate(() => {
      // ── 1. Find the heatmap SVG ───────────────────────────────────────
      // Strategy A: look for an SVG containing roughly 168 rects (7×24).
      // Strategy B: anchor on the "Active times" header and walk up.
      let heatmapSvg: SVGSVGElement | null = null;

      const allSvg = Array.from(document.querySelectorAll('svg')) as SVGSVGElement[];
      const candidates = allSvg
        .map((svg) => ({ svg, n: svg.querySelectorAll('rect').length }))
        .filter(({ n }) => n >= 140 && n <= 220)
        .sort((a, b) => Math.abs(168 - a.n) - Math.abs(168 - b.n));

      if (candidates.length > 0) heatmapSvg = candidates[0].svg;

      if (!heatmapSvg) {
        const allEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div'));
        const header = allEls.find((el) =>
          /^\s*active\s+times\s*$/i.test(el.textContent ?? ''),
        );
        if (header) {
          let p: Element | null = header;
          for (let i = 0; i < 8 && p; i++) {
            const svg = p.querySelector?.('svg');
            if (svg) {
              const rects = svg.querySelectorAll('rect').length;
              if (rects >= 100) {
                heatmapSvg = svg as SVGSVGElement;
                break;
              }
            }
            p = p.parentElement;
          }
        }
      }

      if (!heatmapSvg) return { error: 'heatmap svg not found' };

      // ── 2. Pull cell rects ────────────────────────────────────────────
      const rects = Array.from(heatmapSvg.querySelectorAll('rect')) as SVGRectElement[];

      const cells = rects.map((r) => {
        const x = parseFloat(r.getAttribute('x') ?? '0');
        const y = parseFloat(r.getAttribute('y') ?? '0');
        const w = parseFloat(r.getAttribute('width') ?? '0');
        const h = parseFloat(r.getAttribute('height') ?? '0');
        let fill = r.getAttribute('fill') ?? '';
        if (!fill || fill === 'none' || fill === 'transparent') {
          fill = (getComputedStyle(r).fill ?? '').toString();
        }
        return { x, y, w, h, fill };
      })
      .filter((c) =>
        c.w > 0 && c.h > 0 && c.w < 200 && c.h < 200 &&  // skip background rects
        c.fill && c.fill !== 'none' && c.fill !== 'transparent',
      );

      if (cells.length < 100) {
        return { error: `only ${cells.length} cells found (expected ~168)` };
      }

      // Distinct columns (x) and rows (y). Use rounded values to tolerate
      // sub-pixel jitter, then dedupe within ±2px buckets.
      const bucket = (n: number, eps = 2) => Math.round(n / eps) * eps;
      const xSet = new Set<number>(); const ySet = new Set<number>();
      for (const c of cells) { xSet.add(bucket(c.x)); ySet.add(bucket(c.y)); }
      const xs = Array.from(xSet).sort((a, b) => a - b);
      const ys = Array.from(ySet).sort((a, b) => a - b);

      if (xs.length < 5 || ys.length < 20) {
        return { error: `grid shape ${xs.length}×${ys.length} not 7×24` };
      }

      // ── 3. Day-axis labels (Mo, Tu, …) → day-of-week mapping ──────────
      const texts = Array.from(heatmapSvg.querySelectorAll('text'));
      const dayNameToDow: Record<string, number> = {
        Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6,
      };
      const labelPositions: Array<{ x: number; dow: number }> = [];
      for (const t of texts) {
        const txt = (t.textContent ?? '').trim();
        if (/^(Su|Mo|Tu|We|Th|Fr|Sa)$/i.test(txt)) {
          const tx = parseFloat(t.getAttribute('x') ?? '0');
          const key = txt.charAt(0).toUpperCase() + txt.charAt(1).toLowerCase();
          if (dayNameToDow[key] !== undefined) {
            labelPositions.push({ x: tx, dow: dayNameToDow[key] });
          }
        }
      }

      const xToDow: Record<number, number> = {};
      if (labelPositions.length >= 5) {
        for (const x of xs) {
          let best = labelPositions[0], bestDist = Math.abs(labelPositions[0].x - x);
          for (const lp of labelPositions) {
            const d = Math.abs(lp.x - x);
            if (d < bestDist) { bestDist = d; best = lp; }
          }
          xToDow[x] = best.dow;
        }
      } else {
        // Fallback: assume left→right = Mo, Tu, We, Th, Fr, Sa, Su
        const order = [1, 2, 3, 4, 5, 6, 0];
        xs.forEach((x, i) => { xToDow[x] = order[i] ?? 0; });
      }

      // y → hour: top row is 12am (hour 0)
      const yToHour: Record<number, number> = {};
      ys.forEach((y, i) => { yToHour[y] = i; });

      // ── 4. Color → luminance → intensity ──────────────────────────────
      const parseRgb = (s: string): [number, number, number] => {
        const trimmed = s.trim();
        if (trimmed.startsWith('#')) {
          const hex = trimmed.slice(1);
          const h = hex.length === 3
            ? hex.split('').map((ch) => ch + ch).join('')
            : (hex + '000000').slice(0, 6);
          return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
          ];
        }
        const m = trimmed.match(/rgba?\(([^)]+)\)/);
        if (!m) return [0, 0, 0];
        const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
        return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
      };

      const luminance = (rgb: [number, number, number]) =>
        0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

      const cellByPos: Record<string, { l: number; fill: string }> = {};
      const lums: number[] = [];
      for (const c of cells) {
        const xr = bucket(c.x), yr = bucket(c.y);
        const rgb = parseRgb(c.fill);
        const l = luminance(rgb);
        cellByPos[`${xr},${yr}`] = { l, fill: c.fill };
        lums.push(l);
      }

      const minL = Math.min(...lums);
      const maxL = Math.max(...lums);
      const range = Math.max(1, maxL - minL);

      // 7 days × 24 hours, indexed by Sunday=0
      const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      const levels: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      let filled = 0;

      for (const x of xs) {
        for (const y of ys) {
          const cell = cellByPos[`${x},${y}`];
          if (!cell) continue;
          const dow = xToDow[x];
          const hour = yToHour[y];
          if (dow == null || hour == null) continue;
          // Darker fill = more engaged → invert normalized luminance
          const intensity = Math.max(0, Math.min(1, 1 - (cell.l - minL) / range));
          matrix[dow][hour] = intensity;
          levels[dow][hour] = Math.min(4, Math.floor(intensity * 5));
          filled++;
        }
      }

      return { matrix, levels, cellCount: filled };
    });

    if ('error' in data && data.error) {
      return { ok: false, error: data.error };
    }

    return {
      ok: true,
      matrix: (data as { matrix: number[][] }).matrix,
      levels: (data as { levels: number[][] }).levels,
      cellCount: (data as { cellCount: number }).cellCount,
    };
  } catch (err) {
    logger.warn('Audience scrape threw', { err: String(err) });
    return { ok: false, error: String(err) };
  } finally {
    await page.close();
  }
}
