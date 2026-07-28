import path from 'path';

const PLACEHOLDER_TOPIC = 'xposter-your-secret-topic';
const DEFAULT_IMAGE_WIDTH = 640;
const DEFAULT_IMAGE_HEIGHT = 800;
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image';
const DEFAULT_GEMINI_IMAGE_SIZE = '1K';
const DEFAULT_IMAGE_QA_MODEL = 'opus';
const DEFAULT_AGENTIC_GEN_MAX_TURNS = 12;
const DEFAULT_CLAUDE_GENERATOR_MODEL = 'claude-opus-5';

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function parseIntValue(value: string | undefined, fallback: number, min = Number.MIN_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

export function getPort(): string {
  return process.env.PORT ?? '3000';
}

export function getHost(): string {
  return process.env.HOST ?? '0.0.0.0';
}

export function getBrowserUserDataDir(): string {
  return path.resolve(process.cwd(), process.env.BROWSER_USER_DATA_DIR ?? './browser-profile');
}

export function isBrowserHeadless(): boolean {
  return parseBool(process.env.BROWSER_HEADLESS, true);
}

export function getApiKey(): string | null {
  return process.env.API_KEY?.trim() || null;
}

export function isApiKeySet(): boolean {
  const apiKey = getApiKey();
  return Boolean(apiKey) && apiKey !== 'change_me_generate_with_openssl_rand_hex_32';
}

export function getLogLevel(): string {
  return process.env.LOG_LEVEL?.trim() || 'info';
}

export function getDbPathOverride(): string | null {
  const value = process.env.DB_PATH_OVERRIDE?.trim();
  return value && value !== '' ? value : null;
}

export function getVoyageRpm(): number {
  const rpm = parseFloat(process.env.VOYAGE_RPM ?? '');
  return Number.isFinite(rpm) && rpm > 0 ? rpm : 2.7;
}

export function getContextIngestIntervalMin(): number | null {
  const value = parseInt(process.env.CONTEXT_INGEST_INTERVAL_MIN ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function getEnvVar(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

export function getTrustDashboardOrigin(): boolean {
  return parseBool(process.env.TRUST_DASHBOARD_ORIGIN, true);
}

export function getNtfyTopic(): string | null {
  const topic = process.env.NTFY_TOPIC?.trim();
  return topic && topic !== PLACEHOLDER_TOPIC ? topic : null;
}

export function getNtfyServer(): string {
  return (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, '');
}

export function getNtfyActionMode(): 'view' | 'http' {
  const action = (process.env.NTFY_ACTION_MODE ?? 'view').trim().toLowerCase();
  return action === 'http' ? 'http' : 'view';
}

export function getCallbackNetwork(): string {
  return (process.env.CALLBACK_NETWORK ?? 'lan').trim().toLowerCase();
}

export function getCallbackBaseUrl(): string | null {
  const url = process.env.CALLBACK_BASE_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

export function getTailScaleIpOverride(): string | null {
  const ip = process.env.TAILSCALE_IP?.trim();
  return ip || null;
}

export function isContextEnabled(): boolean {
  return parseBool(process.env.CONTEXT_ENABLED, false);
}

export function getVoyageApiKey(): string | null {
  return process.env.VOYAGE_API_KEY?.trim() || null;
}

export function getVoyageDim(): number {
  return parseIntValue(process.env.VOYAGE_DIM, 512, 1);
}

export function isAgentInfraEnabled(): boolean {
  return parseBool(process.env.AGENT_ENABLED, true);
}

export function getAgentModel(): string {
  return process.env.AGENT_MODEL?.trim() || 'claude-sonnet-4-5';
}

export function getAgentMaxRunsPerDay(): number {
  return parseIntValue(process.env.AGENT_MAX_RUNS_PER_DAY, 10, 0);
}

export function getAgentWatchIntervalMs(): number {
  return parseIntValue(process.env.AGENT_WATCH_INTERVAL_MS, 300_000, 30_000);
}

export function getAgentBaseBranch(): string {
  return process.env.AGENT_BASE_BRANCH?.trim() || 'main';
}

export function getAllowAgentWeb(): boolean {
  return parseBool(process.env.AGENT_ALLOW_WEB, false);
}

export function getAgentCliPath(): string | null {
  return process.env.CLAUDE_CLI_PATH?.trim() || null;
}

export function getAgentInvestigatorMaxTurns(): number {
  return parseIntValue(process.env.AGENT_INVESTIGATOR_MAX_TURNS, 30, 1);
}

export function getAgentImplementerMaxTurns(): number {
  return parseIntValue(process.env.AGENT_IMPLEMENTER_MAX_TURNS, 60, 1);
}

export function shouldLogPrompts(): boolean {
  if (process.env.LOG_PROMPTS?.trim().toLowerCase() === 'false') return false;
  if (process.env.NODE_ENV?.trim() === 'test' && process.env.LOG_PROMPTS?.trim().toLowerCase() !== 'true') return false;
  return true;
}

export function getImageQaModelOverride(): string | null {
  return process.env.IMAGE_QA_MODEL?.trim() || null;
}

export function getClaudeGeneratorModel(): string {
  return process.env.CLAUDE_GENERATOR_MODEL?.trim() || DEFAULT_CLAUDE_GENERATOR_MODEL;
}

export function getGroqApiKey(): string | null {
  return process.env.GROQ_API_KEY?.trim() || null;
}

export function getGroqModel(): string {
  return process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';
}

export function getXAuthToken(): string | null {
  return process.env.X_AUTH_TOKEN?.trim() || null;
}

export function getXCt0(): string | null {
  return process.env.X_CT0?.trim() || null;
}

export function getXHandle(): string | null {
  return process.env.X_HANDLE?.trim() || null;
}

export function getImageWidth(): number {
  const width = parseIntValue(process.env.IMAGE_WIDTH, DEFAULT_IMAGE_WIDTH, 1);
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_IMAGE_WIDTH;
}

export function getImageHeight(): number {
  const height = parseIntValue(process.env.IMAGE_HEIGHT, DEFAULT_IMAGE_HEIGHT, 1);
  return Number.isFinite(height) && height > 0 ? height : DEFAULT_IMAGE_HEIGHT;
}

export function getImageCharacterPrompt(): string | null {
  return process.env.IMAGE_CHARACTER_PROMPT?.trim() || null;
}

export function getImageProviderOverride(): string | null {
  return process.env.IMAGE_PROVIDER?.trim() || null;
}

export function getGeminiImageModel(): string {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export function getGeminiImageSize(): string {
  return process.env.GEMINI_IMAGE_SIZE?.trim() || DEFAULT_GEMINI_IMAGE_SIZE;
}

export function getGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY?.trim() || null;
}

export function getHfApiKey(): string | null {
  return process.env.HF_API_KEY?.trim() || null;
}

export function getOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export function getImageQaModel(): string {
  return process.env.IMAGE_QA_MODEL?.trim() || DEFAULT_QA_MODEL;
}

export function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function getAgenticGeneratorModel(): string {
  return process.env.AGENTIC_GENERATOR_MODEL?.trim() || DEFAULT_CLAUDE_GENERATOR_MODEL;
}

export function getAgenticGenMaxTurns(): number {
  return parseIntValue(process.env.AGENTIC_GEN_MAX_TURNS, DEFAULT_AGENTIC_GEN_MAX_TURNS, 1);
}

export function getGroqClassifierModel(): string {
  return process.env.GROQ_CLASSIFIER_MODEL?.trim() || getGroqModel();
}

export function getAgentDisallowedPaths(): string[] {
  const extra = (process.env.AGENT_DISALLOWED_PATHS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(['.env', '.env.local', 'data/', 'browser-profile/', 'logs/', ...extra])];
}

export function isTrendsEnabled(): boolean {
  return process.env.X_TRENDS_ENABLED?.trim().toLowerCase() !== 'false';
}

export function getNodeEnv(): string {
  return process.env.NODE_ENV?.trim() || 'development';
}

export function getIngestCron(): string {
  return process.env.INGEST_CRON ?? '*/15 * * * *';
}

export function getActionTokenTTLSeconds(): number {
  const ttl = parseIntValue(process.env.ACTION_TOKEN_TTL_SECONDS, 86400, 1);
  return ttl;
}

export function getMinReplyIntervalSeconds(): number {
  return parseIntValue(process.env.MIN_REPLY_INTERVAL_SECONDS, 300, 0);
}
