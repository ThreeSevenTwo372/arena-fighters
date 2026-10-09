const KINDS = new Set(['cheer', 'applause', 'tomato']);

/** Separate from the arena render tree: reactions never interrupt battle playback. */
export function mountArenaReactions(host, { read, send, onReaction = () => {}, now = Date.now,
  uuid = () => globalThis.crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  host.innerHTML = `<div class="arena-reaction-controls"><strong>From the stands</strong><div><button type="button" data-crowd-reaction="cheer">Cheer</button><button type="button" data-crowd-reaction="applause">Applaud</button><button type="button" data-crowd-reaction="tomato">Throw tomato</button></div><span role="status" data-reaction-status>Cosmetic crowd reactions.</span></div>`;
  const buttons = [...host.querySelectorAll('[data-crowd-reaction]')];
  const status = host.querySelector('[data-reaction-status]');
  let room = null, generation = 0, request = null, sending = false, pending = null, timer = null, error = '', disposed = false;
  const seen = new Set();
  function update() {
    clearTimer(timer);
    const remaining = room ? Math.max(0, room.nextSendAt - now()) : 0;
    for (const button of buttons) button.disabled = !room?.canSend || sending || remaining > 0;
    if (status) status.textContent = error || (sending ? 'Sending…' : remaining > 0 ? `Another reaction in ${Math.ceil(remaining / 1000)}s.` : 'Cosmetic crowd reactions.');
    if (remaining > 0) timer = setTimer(update, Math.min(remaining, 1000));
  }
  function accept(result, emit = true) {
    if (!room || result?.tournamentId !== room.tournamentId || result?.code !== room.code) return;
    room.canSend = result.available !== false && result.canSend !== false;
    room.nextSendAt = Math.max(room.nextSendAt, Number(result.nextSendAt) || 0);
    for (const reaction of result.reactions || []) {
      if (!KINDS.has(reaction.kind) || typeof reaction.id !== 'string' || seen.has(reaction.id)) continue;
      seen.add(reaction.id);
      if (emit && Number.isFinite(reaction.createdAt) && now() - reaction.createdAt >= 0 && now() - reaction.createdAt < (result.ttlMs || 6000)) onReaction(reaction);
    }
    while (seen.size > 96) seen.delete(seen.values().next().value);
    error = ''; update();
  }
  async function refresh() {
    if (!room || request || disposed) return;
    const epoch = generation, code = room.code;
    const operation = Promise.resolve().then(() => read(code));
    request = operation;
    try { const result = await operation; if (epoch === generation && !disposed) accept(result); }
    catch { /* Cosmetic polling failures do not block the match. */ }
    finally { if (request === operation) request = null; }
  }
  async function click(event) {
    const button = event.target.closest('[data-crowd-reaction]');
    const kind = button?.dataset.crowdReaction;
    if (!KINDS.has(kind) || button.disabled || !room?.canSend || sending || disposed) return;
    const epoch = generation, code = room.code;
    // Keep an uncertain request's exact command ID for retry; never duplicate a throw.
    pending = pending || { commandId: uuid(), kind };
    sending = true; error = ''; update();
    try {
      const result = await send(code, pending);
      if (epoch !== generation || disposed) return;
      pending = null;
      room.nextSendAt = now() + (result.minIntervalMs || 3000);
      accept(result);
    } catch (failure) {
      if (epoch !== generation || disposed) return;
      if (failure.status) pending = null;
      error = failure.message || 'Reaction could not send. Try again.';
    } finally { if (epoch === generation) { sending = false; update(); } }
  }
  host.addEventListener('click', click);
  update();
  return {
    setRoom(descriptor) {
      const valid = descriptor && /^[A-Z0-9]{6}$/.test(descriptor.code) && descriptor.tournamentId;
      if (valid && room?.code === descriptor.code && room.tournamentId === descriptor.tournamentId) { host.hidden = descriptor.controls === false; return; }
      generation++; request = null; pending = null; sending = false; error = ''; seen.clear(); clearTimer(timer);
      room = valid ? { code: descriptor.code, tournamentId: descriptor.tournamentId, canSend: true, nextSendAt: 0 } : null;
      host.hidden = !room || descriptor.controls === false; update();
      if (room) void refresh();
    },
    refresh,
    dispose() { disposed = true; generation++; clearTimer(timer); host.removeEventListener('click', click); host.hidden = true; },
  };
}
