import en from './en.json';
import ko from './ko.json';

export type Lang = 'en' | 'ko';

export type Entry = { en: string; ko: string };

// en.json / ko.json each hold one flat string per key; merge them side by side
// into { en, ko } entries so a missing translation falls back per language.
const enEntries = en as Record<string, string>;
const koEntries = ko as Record<string, string>;

export const catalogs: Record<string, Entry> = Object.fromEntries(
  [...new Set([...Object.keys(enEntries), ...Object.keys(koEntries)])].map((key) => [
    key,
    { en: enEntries[key] ?? key, ko: koEntries[key] ?? enEntries[key] ?? key },
  ]),
);

export function lookup(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const entry = catalogs[key];
  if (!entry) return key;
  let text = entry[lang];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
