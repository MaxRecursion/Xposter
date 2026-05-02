import axios from 'axios';
import type { ContextSource, ContextSourceResult } from '../types.js';

export interface WeatherSourceConfig {
  name: string;
  location: string;             // 'Pune' — wttr.in accepts city names
  intervalMinutes: number;
  credibility: number;
  /** TTL for stored items in seconds. Defaults to 6 hours. */
  ttlSeconds?: number;
}

interface WttrCondition {
  temp_C: string;
  FeelsLikeC: string;
  humidity: string;
  weatherDesc: Array<{ value: string }>;
  windspeedKmph: string;
  precipMM: string;
}

interface WttrAstronomy {
  sunrise: string;
  sunset: string;
}

interface WttrDay {
  date: string;
  maxtempC: string;
  mintempC: string;
  totalSnow_cm: string;
  uvIndex: string;
  hourly: Array<{ time: string; tempC: string; weatherDesc: Array<{ value: string }>; chanceofrain: string }>;
  astronomy: WttrAstronomy[];
}

interface WttrResponse {
  current_condition: WttrCondition[];
  weather: WttrDay[];
  nearest_area: Array<{ areaName: Array<{ value: string }>; region: Array<{ value: string }> }>;
}

const DEFAULT_TTL = 6 * 3600;

export function weatherSource(cfg: WeatherSourceConfig): ContextSource {
  const ttl = cfg.ttlSeconds ?? DEFAULT_TTL;

  return {
    name: cfg.name,
    intervalMinutes: cfg.intervalMinutes,
    async fetch(): Promise<ContextSourceResult> {
      const resp = await axios.get<WttrResponse>(
        `https://wttr.in/${encodeURIComponent(cfg.location)}?format=j1`,
        {
          timeout: 15_000,
          headers: {
            'User-Agent': 'Xposter-context/1.0 (single-user)',
            Accept: 'application/json',
          },
        },
      );

      const data = resp.data;
      if (!data?.current_condition?.length) {
        return { source: cfg.name, items: [] };
      }

      const cur = data.current_condition[0];
      const today = data.weather?.[0];
      const tomorrow = data.weather?.[1];
      const desc = cur.weatherDesc?.[0]?.value ?? 'unknown';

      const lines: string[] = [];
      lines.push(
        `${cfg.location} weather now: ${desc}, ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C), ` +
        `humidity ${cur.humidity}%, wind ${cur.windspeedKmph} km/h, precip ${cur.precipMM} mm.`,
      );
      if (today) {
        const peakRain = today.hourly?.reduce((m, h) => Math.max(m, parseInt(h.chanceofrain, 10) || 0), 0) ?? 0;
        lines.push(`Today: ${today.mintempC}–${today.maxtempC}°C, peak rain chance ${peakRain}%.`);
      }
      if (tomorrow) {
        lines.push(`Tomorrow: ${tomorrow.mintempC}–${tomorrow.maxtempC}°C.`);
      }

      const now = Math.floor(Date.now() / 1000);
      const body = lines.join(' ');

      return {
        source: cfg.name,
        items: [{
          source: cfg.name,
          sourceUrl: `https://wttr.in/${encodeURIComponent(cfg.location)}`,
          title: `${cfg.location} weather snapshot`,
          body,
          language: 'english',
          publishedAt: now,
          expiresAt: now + ttl,
          credibility: cfg.credibility,
        }],
      };
    },
  };
}
