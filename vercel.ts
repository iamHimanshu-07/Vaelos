import { routes, type VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  buildCommand: 'npm install', // Just install, since there's no build step for this Express app
  framework: 'container',
  rewrites: [
    { source: '/api/(.*)', destination: '/server.js' },
    { source: '/(.*)', destination: '/public/$1' },
  ],
  headers: [
    routes.cacheControl('/public/(.*)', { public: true, maxAge: '1 day' }),
  ],
};
