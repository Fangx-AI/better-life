import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './scripts/content.mjs';
import { createApiRuntime } from './server/membership-runtime.mjs';
import { qaMiddleware } from './server/node-adapter.mjs';
import { publicBasePath } from './scripts/site-base.mjs';
import { PRIVATE_FS_DENY } from './server/private-files.mjs';
function localQa(env) {
  const corpus=loadCorpus(fileURLToPath(new URL('.',import.meta.url)));
  const install=server=>{
    const runtime=createApiRuntime({env,getCorpus:()=>corpus});
    server.middlewares.use(qaMiddleware(runtime.handler));
    server.httpServer?.once('close',runtime.close);
  };
  return {name:'better-life-local-qa',configureServer:install,configurePreviewServer:install};
}
export default defineConfig(({command,isPreview,mode})=>{
  const env={...loadEnv(mode,process.cwd(),''),...process.env};
  const localDemo=env.MEMBERSHIP_LOCAL_DEMO==='true' && env.NODE_ENV!=='production';
  return {
  base: command==='build'||isPreview ? publicBasePath(process.env.PUBLIC_BASE_PATH || '/better-life/') : '/',
  plugins:[react(),tailwind(),localQa(env)],
  resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},
  build:{outDir:'dist/client'},
  server:{host:localDemo?'127.0.0.1':'0.0.0.0',allowedHosts:['terminal.local'],fs:{deny:PRIVATE_FS_DENY},warmup:{clientFiles:['./src/main.jsx']}},
  preview:{host:'127.0.0.1'},
};});
