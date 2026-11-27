import { describe, expect, test } from 'bun:test';
import { etTime, parseEnv, resolveVisionApiKey, todayEt, visionSource } from '../src/wire/deps';

// ---------- parseEnv ----------

const FULL_ENV = {
  DATABASE_URL: 'mysql://root:test@127.0.0.1:3307/st_test',
  APP_PASSWORD: 'hunter2',
  SESSION_SECRET: 's3cret',
  TELEGRAM_BOT_TOKEN: '123456:ABC-DEF',
  TELEGRAM_ALLOWED_CHAT_IDS: '111,222',
  VISION_BASE_URL: 'https://vision.example/v1',
  VISION_MODEL: 'vision-model',
  VISION_API_KEY: 'vkey',
};

describe('parseEnv', () => {
  test('parses a full env and applies defaults', () => {
    const cfg = parseEnv(FULL_ENV);
    expect(cfg.port).toBe(8080);
    expect(cfg.databaseUrl).toBe('mysql://root:test@127.0.0.1:3307/st_test');
    expect(cfg.appPassword).toBe('hunter2');
    expect(cfg.sessionSecret).toBe('s3cret');
    expect(cfg.digestLang).toBe('en');
    expect(cfg.telegram).toEqual({
      token: '123456:ABC-DEF',
      allowedChatIds: ['111', '222'],
      visionBaseUrl: 'https://vision.example/v1',
      visionModel: 'vision-model',
    });
    expect(cfg.visionApiKey).toBe('vkey');
  });

  test('empty-string vars count as unset; telegram null disables the bot', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'mysql://x', APP_PASSWORD: 'p', SESSION_SECRET: 's', PORT: '9000',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_CHAT_IDS: '', VISION_BASE_URL: '', VISION_MODEL: '',
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.telegram).toBeNull();
  });

  test('vision variables are read without a bot token', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'mysql://x', APP_PASSWORD: 'p', SESSION_SECRET: 's',
      VISION_BASE_URL: 'https://vision.example/v1', VISION_MODEL: 'vision-model',
    });
    expect(cfg.telegram).toBeNull();
    expect(cfg.visionBaseUrl).toBe('https://vision.example/v1');
    expect(cfg.visionModel).toBe('vision-model');
  });

  test('without a token the vision variables are optional', () => {
    const base = { DATABASE_URL: 'mysql://x', APP_PASSWORD: 'p', SESSION_SECRET: 's' };
    for (const env of [base, { ...base, VISION_BASE_URL: '  ', VISION_MODEL: '  ' }]) {
      const cfg = parseEnv(env);
      expect(cfg.visionBaseUrl).toBe('');
      expect(cfg.visionModel).toBe('');
    }
  });

  test("with a token the top-level vision values are the bot's", () => {
    const cfg = parseEnv(FULL_ENV);
    expect(cfg.visionBaseUrl).toBe(cfg.telegram!.visionBaseUrl);
    expect(cfg.visionModel).toBe(cfg.telegram!.visionModel);
  });

  test('one error lists every missing variable name', () => {
    let message = '';
    try {
      parseEnv({});
      throw new Error('should have thrown');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('invalid environment');
    for (const name of ['DATABASE_URL', 'APP_PASSWORD', 'SESSION_SECRET']) expect(message).toContain(name);
    for (const name of ['TELEGRAM_BOT_TOKEN', 'VISION_BASE_URL', 'VISION_MODEL']) expect(message).not.toContain(name);

    let msg2 = '';
    try {
      parseEnv({ TELEGRAM_BOT_TOKEN: 'tok', PORT: 'not-a-number', DIGEST_LANG: 'de' });
      throw new Error('should have thrown');
    } catch (err) {
      msg2 = (err as Error).message;
    }
    for (const name of ['DATABASE_URL', 'APP_PASSWORD', 'SESSION_SECRET', 'TELEGRAM_ALLOWED_CHAT_IDS', 'VISION_BASE_URL', 'VISION_MODEL', 'PORT', 'DIGEST_LANG'])
      expect(msg2).toContain(name);
  });

  describe('DEFAULT_COST_PERCENT', () => {
    test('unset defaults to 700 ppm', () => {
      expect(parseEnv(FULL_ENV).defaultCostPpm).toBe(700);
    });
    test('blank counts as unset', () => {
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: '  ' }).defaultCostPpm).toBe(700);
    });
    test('0 means zero, not unset', () => {
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: '0' }).defaultCostPpm).toBe(0);
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: '0.000' }).defaultCostPpm).toBe(0);
    });
    test.each([
      ['0.07', 700],
      ['0.125', 1250],
      ['0.1', 1000],
      ['0.001', 10],
      ['1', 10_000],
      ['12.5', 125_000],
      ['100', 1_000_000],
      ['100.000', 1_000_000],
    ])('%p converts exactly to %p ppm', (v, ppm) => {
      expect(parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: v }).defaultCostPpm).toBe(ppm);
    });
    test.each(['abc', '0.0001', '-1', '101', '100.001', '1.', '.5', '1e1', '1,5'])('rejects %p by name', (v) => {
      expect(() => parseEnv({ ...FULL_ENV, DEFAULT_COST_PERCENT: v })).toThrow(/DEFAULT_COST_PERCENT/);
    });
    test('a bad value joins the other offending variables in one error', () => {
      let message = '';
      try {
        parseEnv({ DEFAULT_COST_PERCENT: 'abc', PORT: 'x' });
      } catch (err) {
        message = (err as Error).message;
      }
      for (const name of ['DATABASE_URL', 'PORT', 'DEFAULT_COST_PERCENT']) expect(message).toContain(name);
    });
  });
});

describe('vision sources', () => {
  test('a non-empty Settings value is settings, anything else env; the key is none only when both are empty', () => {
    expect(visionSource('http://a')).toBe('settings');
    expect(visionSource('')).toBe('env');
    expect(visionSource(undefined)).toBe('env');
    expect(resolveVisionApiKey('sk-s', 'sk-e')).toEqual({ key: 'sk-s', source: 'settings' });
    expect(resolveVisionApiKey('', 'sk-e')).toEqual({ key: 'sk-e', source: 'env' });
    expect(resolveVisionApiKey(undefined, '')).toEqual({ key: '', source: 'none' });
  });
});

describe('todayEt', () => {
  test('formats pinned instants in America/New_York', () => {
    // 04:30Z is 23:30 EST the *previous* day — proves the impl is TZ-aware, not a UTC date slice
    expect(todayEt(new Date('2025-12-31T04:30:00Z'))).toBe('2025-12-30');
    expect(todayEt(new Date('2025-12-31T05:30:00Z'))).toBe('2025-12-31');
    expect(todayEt(new Date('2026-01-01T05:30:00Z'))).toBe('2026-01-01');
  });
  test('defaults to the current date', () => {
    expect(todayEt()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('etTime', () => {
  test('formats pinned instants as 24-hour HH:MM in America/New_York', () => {
    expect(etTime(new Date('2026-11-25T05:00:00Z'))).toBe('00:00');
    expect(etTime(new Date('2026-11-24T21:29:00Z'))).toBe('16:29');
    expect(etTime(new Date('2026-11-24T22:30:00Z'))).toBe('17:30');
    expect(etTime(new Date('2026-07-01T21:00:00Z'))).toBe('17:00');
  });
  test('defaults to the current time', () => {
    expect(etTime()).toMatch(/^\d{2}:\d{2}$/);
  });
});
