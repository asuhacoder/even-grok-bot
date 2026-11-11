import { defineConfig, loadEnv } from 'vite';
import { rejectPackagedSecrets } from './src/relay-config.ts';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  if (mode === 'package') rejectPackagedSecrets(env);
  return {
    ...(mode === 'development'
      ? {}
      : {
          define: {
            'import.meta.env.VITE_RELAY_URLS': JSON.stringify(''),
            'import.meta.env.VITE_RELAY_URL': JSON.stringify(''),
            'import.meta.env.VITE_RELAY_TOKEN': JSON.stringify(''),
          },
        }),
    server: { host: '127.0.0.1', port: 5173, fs: { allow: ['..'] } },
    base: './',
    build: { target: 'esnext' },
  };
});
