/** A full arena view with separate seat-level audience artwork in front. */
export function renderSpectatorFrame(arenaStage, { hud = '' } = {}) {
  return `<div class="spectator-view">${hud ? `<div class="spectator-battle-hud">${hud}</div>` : ''}<div class="spectator-frame"><div class="spectator-field">${arenaStage}</div><img class="spectator-frame-art" src="/assets/arena/spectator-rows-v004.png" alt="" aria-hidden="true" draggable="false"></div></div>`;
}
