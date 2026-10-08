/** Public verdict presentation; deadlines, permissions and votes remain authoritative. */
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const choice = value => value === 'execute' ? 'Kill' : value === 'spare' ? 'Spare' : null;

function timer(deadline, now) {
  const valid = Number.isFinite(deadline) && Number.isFinite(now);
  const seconds = valid ? Math.min(20, Math.max(0, Math.ceil((deadline - now) / 1000))) : 20;
  return `<div class="mercy-clock" role="timer" aria-label="Verdict time remaining"><span${valid ? ` data-deadline="${deadline}"` : ''}>${seconds}</span><small>s</small></div>`;
}

/** A stable winner segment precedes the mercy prompt; the caller owns its one-second timing. */
export function renderMercyPanel({ phase = 'mercy', winnerName = 'The victor', isWinner = false,
  deadline = null, now = Date.now(), crowdVote = null, disabled = false } = {}) {
  if (!['winner', 'mercy', 'crowd'].includes(phase)) return '';
  const winner = `<div class="mercy-winner"><strong>${escape(winnerName)}</strong><span>WINNER!</span></div>`;
  if (phase === 'winner') return `<section class="mercy-panel mercy-winner-reveal" role="status" aria-label="Duel winner">${winner}</section>`;
  if (phase === 'crowd') {
    const spare = count(crowdVote?.counts?.spare), kill = count(crowdVote?.counts?.execute);
    const voted = choice(crowdVote?.yourVote);
    const allowed = crowdVote?.canVote === true && !voted && !disabled;
    const buttons = crowdVote?.canVote === true || voted
      ? `<div class="mercy-actions crowd-vote-actions"><button type="button" class="button mercy-spare" data-action="crowd-vote" data-value="spare" aria-pressed="${crowdVote?.yourVote === 'spare'}"${allowed ? '' : ' disabled'}>Spare</button><button type="button" class="button danger mercy-kill" data-action="crowd-vote" data-value="execute" aria-pressed="${crowdVote?.yourVote === 'execute'}"${allowed ? '' : ' disabled'}>Kill</button></div>` : '';
    return `<section class="mercy-panel mercy-crowd-panel" aria-label="Crowd verdict"><div class="mercy-question-row"><h2>THE CROWD DECIDES</h2>${timer(crowdVote?.deadline ?? deadline, now)}</div><div class="crowd-vote-counts" aria-label="Current crowd votes"><span>Spare <strong>${spare}</strong></span><span>Kill <strong>${kill}</strong></span></div>${buttons}${voted ? `<p class="mercy-vote-status" role="status">Your vote: ${voted}</p>` : ''}</section>`;
  }
  return `<section class="mercy-panel" aria-label="Mercy verdict">${winner}<div class="mercy-question-row"><h2>MERCY?</h2>${timer(deadline, now)}</div>${isWinner ? `<div class="mercy-actions"><button type="button" class="button primary mercy-spare" data-action="mercy" data-value="spare"${disabled ? ' disabled' : ''}>Spare</button><button type="button" class="button danger mercy-kill" data-action="mercy" data-value="execute"${disabled ? ' disabled' : ''}>Kill</button><button type="button" class="button mercy-crowd" data-action="mercy" data-value="crowd"${disabled ? ' disabled' : ''}>Let crowd decide</button></div>` : '<p class="mercy-vote-status" role="status">Awaiting the winner’s verdict.</p>'}</section>`;
}

function outcomeKind(decision) {
  const value = typeof decision === 'object' ? decision?.decision : decision;
  return value === 'spare' || value === 'execute' ? value : null;
}

function bloodDrips() {
  const palette = ['#570d1b', '#821624', '#a9232e'];
  let cells = '<rect width="320" height="7" fill="#821624"/>';
  for (let i = 0; i < 20; i++) {
    const x = i * 16 + (i * 7) % 8;
    const height = 22 + (i * 19) % 64;
    const width = 3 + (i % 3) * 2;
    cells += `<g class="outcome-blood-drip" style="--drip-delay:${(i % 4) * 80}ms"><rect x="${x}" y="4" width="${width}" height="${height}" fill="${palette[i % 3]}"/><rect x="${x - 1}" y="${height}" width="${width + 2}" height="4" fill="${palette[i % 3]}"/></g>`;
    if (i % 4 === 1) cells += `<rect class="outcome-blood-drop" x="${x}" y="${height + 9}" width="3" height="5" fill="#a9232e" style="--drip-delay:${350 + (i % 5) * 130}ms"/>`;
  }
  return `<svg class="outcome-blood" viewBox="0 0 320 120" preserveAspectRatio="none" shape-rendering="crispEdges" aria-hidden="true">${cells}</svg>`;
}

/** Only the defeated client mounts this overlay after the accepted arena verdict. */
export function renderOutcomeOverlay(decision) {
  const kind = outcomeKind(decision);
  if (!kind) return '';
  const dead = kind === 'execute';
  return `<div class="loser-outcome-overlay ${dead ? 'loser-outcome-death' : 'loser-outcome-spared'}" role="status" aria-live="polite" data-loser-outcome="${kind}">${dead ? bloodDrips() : ''}<h2>${dead ? 'Hades takes your soul.' : 'You live to fight another day!'}</h2></div>`;
}

function pause(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false;
    const finish = completed => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) finish(false);
  });
}

/** Preserve the native arena below the brief personal result; abort removes only our overlay. */
export async function playLoserOutcome(container, decision, { signal, reducedMotion, hold = false } = {}) {
  const markup = renderOutcomeOverlay(decision);
  if (!container || !markup || signal?.aborted || !container.isConnected) return false;
  const reduce = reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  let host;
  let retained = false;
  let observer;
  const release = () => {
    observer?.disconnect();
    signal?.removeEventListener('abort', release);
    host?.remove();
  };
  try {
    const document = container.ownerDocument || globalThis.document;
    host = document.createElement('div');
    host.className = `loser-outcome-host${reduce ? ' loser-outcome-reduced' : ''}`;
    host.innerHTML = markup;
    container.append(host);
    signal?.addEventListener('abort', release, { once: true });
    const completed = await pause(reduce ? 650 : 3500, signal) && !signal?.aborted && container.isConnected && host.isConnected;
    if (hold && completed) {
      // Keep the black result above the native arena until an acknowledged leave
      // or next-screen render. A detached host must not retain its abort listener.
      const MutationObserver = document.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      if (MutationObserver && document.documentElement) {
        observer = new MutationObserver(() => { if (!container.isConnected || !host.isConnected) release(); });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      retained = true;
    }
    return completed;
  } finally {
    if (!retained) release();
  }
}
