import type { VisionApiKey, VisionSource } from './capture-route';

export interface TelegramEnv {
  token: string;
  allowedChatIds: string[];
  visionBaseUrl: string;
  visionModel: string;
}

export interface EnvConfig {
  port: number;
  databaseUrl: string;
  appPassword: string;
  sessionSecret: string;
  digestLang: 'en' | 'ko';
  /** per-side trading cost in ppm; from DEFAULT_COST_PERCENT, 700 (0.07 %) when unset */
  defaultCostPpm: number;
  /** null when TELEGRAM_BOT_TOKEN is unset/empty — the bot is disabled */
  telegram: TelegramEnv | null;
  /** read with or without a token (web uploads need them too); '' when unset, required only with a token */
  visionBaseUrl: string;
  visionModel: string;
  visionApiKey: string;
}

const DEFAULT_COST_PPM = 700;
const PERCENT_RE = /^(\d{1,3})(?:\.(\d{1,3}))?$/;

/** "0.125" -> 1250. Integer math only (1 % = 10_000 ppm); null when malformed or above 100 %. */
function percentToPpm(raw: string): number | null {
  const m = PERCENT_RE.exec(raw);
  if (m === null) return null;
  const ppm = Number(m[1]) * 10_000 + Number((m[2] ?? '').padEnd(3, '0')) * 10;
  return ppm <= 1_000_000 ? ppm : null;
}

/**
 * Hand-rolled validation so the failure message can list EVERY offending
 * variable name in one shot (docker-compose debugging, task 15 spec).
 */
export function parseEnv(raw: Record<string, string | undefined> = process.env): EnvConfig {
  const get = (name: string): string | undefined => {
    const v = raw[name];
    return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
  };

  const missing: string[] = [];
  const require = (name: string): string => {
    const v = get(name);
    if (v === undefined) missing.push(name);
    return v ?? '';
  };

  const databaseUrl = require('DATABASE_URL');
  const appPassword = require('APP_PASSWORD');
  const sessionSecret = require('SESSION_SECRET');

  const token = get('TELEGRAM_BOT_TOKEN');
  let telegram: TelegramEnv | null = null;
  if (token !== undefined) {
    const allowedChatIdsRaw = require('TELEGRAM_ALLOWED_CHAT_IDS');
    const visionBaseUrl = require('VISION_BASE_URL');
    const visionModel = require('VISION_MODEL');
    telegram = {
      token,
      allowedChatIds: allowedChatIdsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      visionBaseUrl,
      visionModel,
    };
  }

  let port = 8080;
  const portRaw = get('PORT');
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (!/^\d+$/.test(portRaw) || !Number.isInteger(n) || n <= 0) missing.push('PORT');
    else port = n;
  }

  let digestLang: 'en' | 'ko' = 'en';
  const langRaw = get('DIGEST_LANG');
  if (langRaw !== undefined) {
    if (langRaw === 'en' || langRaw === 'ko') digestLang = langRaw;
    else missing.push('DIGEST_LANG');
  }

  let defaultCostPpm = DEFAULT_COST_PPM;
  const costRaw = get('DEFAULT_COST_PERCENT');
  if (costRaw !== undefined) {
    const ppm = percentToPpm(costRaw);
    if (ppm === null) missing.push('DEFAULT_COST_PERCENT');
    else defaultCostPpm = ppm;
  }

  if (missing.length > 0) {
    throw new Error(`invalid environment: ${missing.join(', ')}`);
  }

  return {
    port,
    databaseUrl,
    appPassword,
    sessionSecret,
    digestLang,
    defaultCostPpm,
    telegram,
    visionBaseUrl: get('VISION_BASE_URL') ?? '',
    visionModel: get('VISION_MODEL') ?? '',
    visionApiKey: get('VISION_API_KEY') ?? '',
  };
}

/** Mirrors `settings.x || env.x`: a non-empty Settings value wins, anything else is env (even an empty one). */
export function visionSource(saved: string | undefined): VisionSource {
  return saved ? 'settings' : 'env';
}

export function resolveVisionApiKey(saved: string | undefined, fromEnv: string): VisionApiKey {
  if (saved) return { key: saved, source: 'settings' };
  if (fromEnv) return { key: fromEnv, source: 'env' };
  return { key: '', source: 'none' };
}

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function todayEt(date: Date = new Date()): string {
  return ET_FMT.format(date);
}

const ET_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 'HH:MM' (24 h) in New York. */
export function etTime(date: Date = new Date()): string {
  return ET_TIME_FMT.format(date);
}
