// Runs in the published Squarespace page, never inside the game or its editor.
(() => {
  if (window.self !== window.top) return;
  const page = new URL(window.location.href);
  if (!['www.blackbooktattoo.com', 'blackbooktattoo.com'].includes(page.hostname)
    || !/^\/arena-fighters\/?$/.test(page.pathname)) return;
  const phone = window.matchMedia('(max-width: 600px), (max-width: 1000px) and (max-height: 500px), (pointer: coarse) and (hover: none)');
  if (!phone.matches) return;
  const source = document.currentScript;
  if (!source?.src) return;
  const script = new URL(source.src);
  if (script.protocol !== 'https:' || script.username || script.password || script.pathname !== '/src/mobile-launch.js') return;
  const destination = new URL('/', script.origin);
  const invite = page.searchParams.get('invite');
  if (/^[A-Z0-9]{6}$/.test(invite ?? '')) destination.searchParams.set('invite', invite);
  if (page.searchParams.get('duel-mode') === '1') destination.searchParams.set('duel-mode', '1');
  window.location.replace(destination.href);
})();
