import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'jp.rdlabo.library.demo',
  appName: 'demo',
  webDir: 'dist/demo/browser',
  server: {
    androidScheme: 'https',
  },
};

export default config;
