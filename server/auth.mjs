import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

const DAY = 24 * 60 * 60 * 1000;
const cookie = 'glamp_session';
const sha = value => createHash('sha256').update(value).digest();
const equal = (left, right) => timingSafeEqual(sha(left), sha(right));
const ownerKey = () => (process.env.GLAMP_OWNER_TOKEN || '').length >= 15 ? process.env.GLAMP_OWNER_TOKEN : null;
const validAgent = token => {
  const plainMatch = (process.env.GLAMP_AGENT_TOKEN || '').split(',').some(secret => {
    const candidate = secret.trim();
    return candidate.length >= 15 && equal(token, candidate);
  });
  if (plainMatch) return true;
  return (process.env.GLAMP_AGENT_TOKEN_HASHES || '').split(',').some(hash =>
    /^[0-9a-f]{64}$/i.test(hash.trim()) && timingSafeEqual(sha(token), Buffer.from(hash.trim(), 'hex')));
};
const sign = payload => createHmac('sha256', ownerKey()).update(`glamp-session-v1:${payload}`).digest('base64url');
const secure = () => process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', path: '/', secure: secure() });

function hasSession(req) {
  if (!ownerKey()) return false;
  const raw = req.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookie + '='))?.slice(cookie.length + 1);
  const parts = raw?.match(/^(\d{13})\.([a-zA-Z0-9_-]{22})\.([a-zA-Z0-9_-]{43})$/);
  return Boolean(parts && +parts[1] > Date.now() && equal(parts[3], sign(`${parts[1]}.${parts[2]}`)));
}

export function identity(req, res, next) {
  const bearer = req.get('authorization')?.match(/^Bearer ([^\s,]{1,1024})$/i)?.[1];
  req.role = hasSession(req) ? 'owner' : bearer && validAgent(bearer) ? 'agent' : null;
  next();
}
export const requireAuth = (req,res,next) => req.role ? next() : res.status(401).json({error:'Sign in or supply an agent token.'});
export const requireOwner = (req,res,next) => req.role === 'owner' ? next() : res.status(403).json({error:'Owner session required.'});

export function guardOrigin(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  let validOrigin = !origin;
  try { if (origin) validOrigin = new URL(origin).host === req.get('host') && ['http:', 'https:'].includes(new URL(origin).protocol); } catch { /* refuse malformed origins */ }
  if (!validOrigin || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({error:'Cross-site request refused.'});
  next();
}

export const sessions = express.Router();
sessions.get('/', (req, res) => res.json({authenticated: Boolean(req.role), owner: req.role === 'owner'}));
sessions.post('/', (req, res) => {
  if (!ownerKey()) return res.status(503).json({error:'Workspace owner sign-in has not been configured.'});
  const token = req.body?.token;
  if (typeof token !== 'string' || !equal(token, ownerKey())) return res.status(401).json({error:'Invalid owner token.'});
  const payload = `${Date.now() + 7 * DAY}.${randomBytes(16).toString('base64url')}`;
  res.cookie(cookie, `${payload}.${sign(payload)}`, {...cookieOptions(), maxAge:7 * DAY});
  res.json({authenticated:true, owner:true});
});
sessions.delete('/', (_req, res) => res.clearCookie(cookie, cookieOptions()).status(204).end());
