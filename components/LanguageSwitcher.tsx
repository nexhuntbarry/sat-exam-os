'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export default function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations('languageSwitcher');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function setLocale(next: 'zh' | 'en') {
    if (next === locale) return;
    document.cookie = `NEXT_LOCALE=${next}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-divider bg-light-bg p-1"
      aria-label={t('label')}
    >
      <button
        type="button"
        onClick={() => setLocale('zh')}
        disabled={pending}
        aria-pressed={locale === 'zh'}
        className={`px-3 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
          locale === 'zh'
            ? 'bg-warm-coral text-white shadow-sm'
            : 'text-mid-gray hover:text-charcoal hover:bg-light-bg'
        }`}
      >
        {t('zh')}
      </button>
      <button
        type="button"
        onClick={() => setLocale('en')}
        disabled={pending}
        aria-pressed={locale === 'en'}
        className={`px-3 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
          locale === 'en'
            ? 'bg-warm-coral text-white shadow-sm'
            : 'text-mid-gray hover:text-charcoal hover:bg-light-bg'
        }`}
      >
        {t('en')}
      </button>
    </div>
  );
}
