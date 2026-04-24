import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { defaultLocale, isLocale, localeCookieName, type Locale } from './config';

function pickFromAcceptLanguage(header: string | null): Locale {
  if (!header) return defaultLocale;
  const langs = header.split(',').map((s) => s.trim().split(';')[0].toLowerCase());
  for (const lang of langs) {
    if (lang.startsWith('zh')) return 'zh';
    if (lang.startsWith('en')) return 'en';
  }
  return defaultLocale;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(localeCookieName)?.value;
  const locale: Locale = isLocale(fromCookie)
    ? fromCookie
    : pickFromAcceptLanguage((await headers()).get('accept-language'));

  const messages = (await import(`../messages/${locale}.json`)).default;

  return {
    locale,
    messages,
  };
});
