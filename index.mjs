import express from 'express';
import { fileURLToPath } from 'node:url';
import { identity, requireAuth, requireOwner, guardOrigin, sessions } from './server/auth.mjs';
import { agentsRouter, cardsRouter, initStore, projectsRouter } from './server/cards.mjs';
import { imagesRouter } from './server/images.mjs';
import { pushRouter, notifyReview } from './server/push.mjs';

const app = express();
app.disable('x-powered-by');
app.locals.notifyReview = notifyReview;
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  next();
});
app.use('/api', (_req,res,next) => { res.set('Cache-Control','private, no-store'); next(); }, guardOrigin, identity);
app.use('/api/session', express.json({ limit: '4kb' }), sessions);
app.use('/api', requireAuth);
// Initialize only when data is requested. Never create or modify a cloud schema on startup.
let initialized;
const ensureStore = async (_req, _res, next) => {
  initialized ??= Promise.resolve().then(initStore).catch(err => { initialized = undefined; throw err; });
  await initialized; next();
};
app.use('/api/cards', ensureStore, imagesRouter, express.json({ limit: '1mb' }), cardsRouter);
app.use('/api/agents', ensureStore, express.json({ limit: '64kb' }), agentsRouter);
app.use('/api/projects', ensureStore, express.json({ limit: '64kb' }), projectsRouter);
app.use('/api/push', requireOwner, express.json({ limit: '8kb' }), pushRouter);
app.use('/api', (_req,res) => res.status(404).json({error:'Unknown API route.'}));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.use((err, _req, res, _next) => {
  const status = Number(err.status || err.statusCode);
  const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  // Never expose database errors, URLs, untrusted request bodies or tokens in API responses or logs.
  if (code >= 500) console.error(`Glamp request failed (${code})`);
  res.status(code).json({
    error: typeof err.publicMessage === 'string'
      ? err.publicMessage
      : code === 413 ? 'Request is too large.'
      : code === 400 ? 'Invalid request.'
      : code === 503 ? 'Workspace storage or service is not configured.'
      : 'Request failed.',
  });
});
export default app;
