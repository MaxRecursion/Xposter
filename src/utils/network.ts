import { networkInterfaces } from 'os';
import { execFileSync } from 'child_process';

const PRIVATE_IPV4_RE =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function getPort(): string {
  return process.env.PORT ?? '3000';
}

export function getBindHost(): string {
  return process.env.HOST ?? '0.0.0.0';
}

/** Returns the first non-loopback IPv4 address (LAN IP). */
export function getLocalIP(): string {
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

  try {
    const output = execFileSync('tailscale', ['ip', '-4'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ip = output.split(/\s+/).find(Boolean);
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
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
