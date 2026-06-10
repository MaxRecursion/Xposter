import { networkInterfaces } from 'os';
import { execFileSync } from 'child_process';

const PRIVATE_IPV4_RE =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const TAILSCALE_IPV4_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

export function getPort(): string {
  return process.env.PORT ?? '3000';
}

export function getBindHost(): string {
  return process.env.HOST ?? '0.0.0.0';
}

// IP lookups are called on every request (CORS origin check + dashboard-origin
// auth). The tailscale lookup in particular shells out to the CLI, which blocks
// the event loop — cache both with a short TTL since interfaces rarely change.
const IP_CACHE_TTL_MS = 60_000;
let _localIp: { value: string; at: number } | null = null;
let _tailscaleIp: { value: string | null; at: number } | null = null;

/** Returns the first non-loopback IPv4 address (LAN IP). */
export function getLocalIP(): string {
  if (_localIp && Date.now() - _localIp.at < IP_CACHE_TTL_MS) return _localIp.value;
  const value = lookupLocalIP();
  _localIp = { value, at: Date.now() };
  return value;
}

function lookupLocalIP(): string {
  const nets = networkInterfaces();
  const preferredNames = ['en0', 'en1', 'eth0', 'wlan0'];
  const names = [
    ...preferredNames.filter((name) => nets[name]),
    ...Object.keys(nets).filter((name) => !preferredNames.includes(name)),
  ];

  for (const name of names) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal && PRIVATE_IPV4_RE.test(net.address)) {
        return net.address;
      }
    }
  }

  for (const name of names) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }

  return '127.0.0.1';
}

/** Returns a Tailscale IPv4 address when the tailscale CLI is installed/logged in. */
export function getTailscaleIP(): string | null {
  if (process.env.TAILSCALE_IP) return process.env.TAILSCALE_IP;
  if (_tailscaleIp && Date.now() - _tailscaleIp.at < IP_CACHE_TTL_MS) return _tailscaleIp.value;
  const value = lookupTailscaleIP();
  _tailscaleIp = { value, at: Date.now() };
  return value;
}

function lookupTailscaleIP(): string | null {
  try {
    const output = execFileSync('tailscale', ['ip', '-4'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ip = output.split(/\s+/).find(Boolean);
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal && TAILSCALE_IPV4_RE.test(net.address)) {
          return net.address;
        }
      }
    }

    return null;
  }
}

export function getLanBase(): string {
  return `http://${getLocalIP()}:${getPort()}`;
}

export function getTailscaleBase(): string | null {
  const ip = getTailscaleIP();
  return ip ? `http://${ip}:${getPort()}` : null;
}

/** Builds the base URL for ntfy callback buttons. */
export function getCallbackBase(): string {
  const envUrl = process.env.CALLBACK_BASE_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');

  const network = (process.env.CALLBACK_NETWORK ?? 'lan').toLowerCase();
  if (network === 'tailscale') {
    return getTailscaleBase() ?? getLanBase();
  }

  return getLanBase();
}

export function getBrowserUrls(): { lan: string; tailscale: string | null } {
  return {
    lan: getLanBase(),
    tailscale: getTailscaleBase(),
  };
}

export function getAllowedDashboardOrigins(): string[] {
  const urls = getBrowserUrls();
  return [
    `http://localhost:${getPort()}`,
    `http://127.0.0.1:${getPort()}`,
    urls.lan,
    urls.tailscale,
    getCallbackBase(),
  ].filter((url): url is string => Boolean(url));
}
