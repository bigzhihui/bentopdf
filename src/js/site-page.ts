import '../css/styles.css';
import {
  initI18n,
  applyTranslations,
  injectLanguageSwitcher,
} from './i18n/index.js';

void initI18n().then(() => {
  injectLanguageSwitcher(['en', 'zh']);
  applyTranslations();
});
