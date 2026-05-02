export interface ContextItemInput {
  source: string;
  sourceUrl: string | null;
  title: string | null;
  body: string;
  language: string | null;
  publishedAt: number | null;
  expiresAt: number | null;
  credibility: number;
}

export interface ContextSourceResult {
  source: string;
  items: ContextItemInput[];
}

export interface ContextSource {
  readonly name: string;
  readonly intervalMinutes: number;
  fetch(): Promise<ContextSourceResult>;
}

export interface RetrievedContextItem {
  itemId: string;
  source: string;
  sourceUrl: string | null;
  title: string | null;
  body: string;
  language: string | null;
  /** JSON-encoded array of Topic strings (see context/topics.ts). */
  topics: string;
  publishedAt: number | null;
  fetchedAt: number;
  credibility: number;
  distance: number;
}
