/** Links carry only a public room code, never a fighter identity or bearer. */
export function createArenaInvite(origin, code, { duel = false } = {}) {
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Invalid arena code.');
  const url = new URL('/', origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid game address.');
  if (duel) url.searchParams.set('duel-mode', '1');
  url.searchParams.set('invite', code);
  return url.href;
}
