const PLACEHOLDER_TOPIC = 'xposter-your-secret-topic';

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
