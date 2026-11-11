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
  /** null when TELEGRAM_BOT_TOKEN is unset/empty — the bot is disabled */
  telegram: TelegramEnv | null;
  visionApiKey: string;
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

  if (missing.length > 0) {
    throw new Error(`invalid environment: ${missing.join(', ')}`);
  }

  return {
    port,
    databaseUrl,
    appPassword,
    sessionSecret,
    digestLang,
    telegram,
    visionApiKey: get('VISION_API_KEY') ?? '',
  };
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
