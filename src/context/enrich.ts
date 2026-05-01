import { ContextStore } from './store/store.js';
import { Retriever } from './retrieve/retriever.js';
import { VoyageEmbeddings } from './embeddings/voyage.js';
import { logger } from '../utils/logger.js';

export interface EnrichInput {
  /** Tweet text or topic phrase used as the retrieval query. */
  text: string;
  /** Caller's language hint; currently advisory. */
  language?: string | null;
  /** Maximum number of items to include in the prompt block. Default 4. */
  maxItems?: number;
  /** Soft cap on the size of the rendered block (~4 chars / token). Default 500. */
  maxTokens?: number;
}

let _store: ContextStore | null = null;
let _retriever: Retriever | null = null;
let _initFailed = false;

export function isContextEnabled(): boolean {
  return process.env.CONTEXT_ENABLED === 'true';
}

function init(): { store: ContextStore; retriever: Retriever } | null {
  if (_retriever && _store) return { store: _store, retriever: _retriever };
  if (_initFailed) return null;

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    logger.warn('CONTEXT_ENABLED=true but VOYAGE_API_KEY is not set — context disabled');
    _initFailed = true;
    return null;
  }

  const dim = parseInt(process.env.VOYAGE_DIM ?? '512', 10) || 512;
  const embeddings = new VoyageEmbeddings(apiKey, dim);
  _store = new ContextStore(embeddings);
  _retriever = new Retriever(_store);
  return { store: _store, retriever: _retriever };
}

export function getContextStore(): ContextStore | null {
  if (!isContextEnabled()) return null;
  return init()?.store ?? null;
}

/**
 * Build a context block ready for injection into a prompt. Returns '' if
 * context is disabled, mis-configured, or retrieval finds nothing — callers
 * pass the result through unchanged when empty.
 */
export async function enrichPrompt(input: EnrichInput): Promise<string> {
  if (!isContextEnabled()) return '';
  const ctx = init();
  if (!ctx) return '';

  try {
    const items = await ctx.retriever.retrieve({
      text: input.text,
      language: input.language ?? null,
      k: input.maxItems ?? 4,
    });
    if (items.length === 0) return '';

    const maxChars = (input.maxTokens ?? 500) * 4;
    const header =
      '[CURRENT CONTEXT — recent local reporting; treat as background only. Do not quote URLs, do not attribute names, do not invent details that are not in the source text.]';
    const lines: string[] = [header];
    let used = header.length;

    for (const it of items) {
      const ageHours = it.publishedAt
        ? Math.max(0, Math.round((Date.now() / 1000 - it.publishedAt) / 3600))
        : null;
      const ago = ageHours == null ? 'recent' : ageHours < 1 ? '<1h ago' : `${ageHours}h ago`;
      const sourceLabel = it.source.replace(/^rss:/, '');
      const head = it.title ? `${it.title} — ` : '';
      const line = `- [${sourceLabel}, ${ago}] ${head}${it.body}`;
      const truncated = line.length > 320 ? line.slice(0, 317) + '…' : line;
      if (used + truncated.length + 1 > maxChars) break;
      lines.push(truncated);
      used += truncated.length + 1;
    }

    if (lines.length === 1) return '';
    lines.push('[/CONTEXT]');
    return lines.join('\n');
  } catch (err) {
    logger.warn('Context enrichment failed; continuing without context', { err: String(err) });
    return '';
  }
}
