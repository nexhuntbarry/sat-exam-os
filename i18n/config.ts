export const locales = ['zh', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'zh';
export const localeCookieName = 'NEXT_LOCALE';

export function isLocale(value: string | undefined): value is Locale {
  return value === 'zh' || value === 'en';
}
