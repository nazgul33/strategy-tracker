import { describe, expect, it } from 'bun:test';

import {
  VR_DEFAULT_SETTINGS_TEXT,
  formulaLabelKey,
  halfCents,
  parseVrSettingsText,
  ppmInputText,
  ppmPercent,
  signedUsdTextToCents,
} from './vrText';

describe('vrText', () => {
  it('formats a ppm percent without trailing zeros', () => {
    expect(ppmPercent(150_000)).toBe('15%');
    expect(ppmPercent(125_000)).toBe('12.5%');
    expect(ppmPercent(0)).toBe('0%');
    expect(ppmPercent(1)).toBe('0.0001%');
    expect(ppmPercent(1_000_000)).toBe('100%');
  });

  it('prefills a ppm percent, keeping 0 as 0', () => {
    expect(ppmInputText(0)).toBe('0');
    expect(ppmInputText(150_000)).toBe('15');
    expect(ppmInputText(125_000)).toBe('12.5');
  });

  it('parses signed dollar text to cents', () => {
    expect(signedUsdTextToCents('-250')).toBe(-25_000);
    expect(signedUsdTextToCents('-1,000.50')).toBe(-100_050);
    expect(signedUsdTextToCents(' 12.5 ')).toBe(1250);
    expect(signedUsdTextToCents('0')).toBe(0);
    expect(signedUsdTextToCents('-0')).toBe(0);
    for (const bad of ['', '-', 'abc', '--5', '-+5', '+5', '1.2.3']) expect(signedUsdTextToCents(bad)).toBeNull();
  });

  it('halves the cash rounding down', () => {
    expect(halfCents(1_000_000)).toBe(500_000);
    expect(halfCents(1001)).toBe(500);
  });

  it('labels the formulas', () => {
    expect(formulaLabelKey('basic')).toBe('vr.formulaBasic');
    expect(formulaLabelKey('skill')).toBe('vr.formulaSkill');
  });

  describe('parseVrSettingsText', () => {
    const base = VR_DEFAULT_SETTINGS_TEXT;
    it('converts the defaults', () => {
      expect(parseVrSettingsText(base)).toEqual({
        settings: { g: 10, formula: 'skill', bandPpm: 150_000, spendLimitPpm: 500_000, cycleDepositCents: 0 },
      });
    });

    it('reports the first failing field in form order', () => {
      expect(parseVrSettingsText({ ...base, g: '0', band: 'x' })).toEqual({ errorKey: 'vr.invalidG' });
      expect(parseVrSettingsText({ ...base, band: '100', spendLimit: 'x' })).toEqual({ errorKey: 'vr.invalidBand' });
      expect(parseVrSettingsText({ ...base, spendLimit: '', deposit: 'x' })).toEqual({ errorKey: 'vr.invalidSpendLimit' });
      expect(parseVrSettingsText({ ...base, deposit: '' })).toEqual({ errorKey: 'vr.invalidDeposit' });
    });

    it('accepts the edges: G 1 and 1000, spend limit 0 and 100, a tiny band', () => {
      expect(parseVrSettingsText({ ...base, g: '1', spendLimit: '0', band: '0.0001' })).toEqual({
        settings: { g: 1, formula: 'skill', bandPpm: 1, spendLimitPpm: 0, cycleDepositCents: 0 },
      });
      expect(parseVrSettingsText({ ...base, g: '1000', spendLimit: '100', band: '99.9999', formula: 'basic' })).toEqual({
        settings: { g: 1000, formula: 'basic', bandPpm: 999_999, spendLimitPpm: 1_000_000, cycleDepositCents: 0 },
      });
    });

    it('rejects G above 1000 and fractional G', () => {
      for (const g of ['1001', '2.5', '', '-1', '1e2']) expect(parseVrSettingsText({ ...base, g })).toEqual({ errorKey: 'vr.invalidG' });
    });
  });
});
