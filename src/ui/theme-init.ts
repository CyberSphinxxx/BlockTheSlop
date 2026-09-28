/**
 * Synchronous theme initializer for extension pages.
 * Loaded via <script type="module" src="/src/ui/theme-init.ts"> in <head> to prevent FOUC.
 */
(() => {
  try {
    const cachedSetting = globalThis.localStorage?.getItem('bts-theme-setting') ?? 'system';
    let resolved = 'specimen-light';
    if (cachedSetting === 'specimen-dark' || cachedSetting === 'dark') {
      resolved = 'specimen-dark';
    } else if (cachedSetting === 'specimen-light' || cachedSetting === 'light') {
      resolved = 'specimen-light';
    } else {
      const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;
      resolved = prefersDark ? 'specimen-dark' : 'specimen-light';
    }
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    const isDark = resolved === 'specimen-dark';
    root.setAttribute('data-bts-theme', isDark ? 'dark' : 'light');
    root.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
    root.classList.toggle('bts-dark', isDark);
  } catch {
    document.documentElement.setAttribute('data-theme', 'specimen-light');
  }
})();
