import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['projects/util/test-setup.ts'],
    server: {
      deps: {
        inline: [
          /@ionic\/angular/,
          /@ionic\/core/,
          /ionicons/,
          /@rdlabo\/ionic-angular-scroll-header/,
          /@rdlabo\/ionic-angular-photo-editor/,
          /@rdlabo\/ngx-cdk-scroll-strategies/,
        ],
      },
    },
  },
});
