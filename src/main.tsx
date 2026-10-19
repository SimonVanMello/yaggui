import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './theme/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { loadPreferences } from './app/preferences';
import { isDemo } from './demo/isDemo';
import { prepareDemo } from './demo/startDemo';
import { initI18n } from './i18n/i18n';
import { initTheme } from './theme/themeStore';

async function bootstrap() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');

  if (isDemo) prepareDemo();
  // Preferences are applied before the first render to avoid a theme or language flash.
  const preferences = await loadPreferences();
  initTheme(preferences.theme, preferences.style);
  initI18n(preferences.locale);

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
