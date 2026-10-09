import { RULES } from './combat.js';

const fighterName = (duel, index) => duel?.fighters?.[index]?.character?.name || `Fighter ${index + 1}`;
const isOnline = context => context.mode === 'online';
const complete = context => context.duel?.status === 'complete';

/** Public UI states. Committed action values are deliberately never inspected. */
export function battlePhase(context = {}) {
  const { duel, phase = 'select', viewer = 0, pending = [false, false], busy = false, offline = false } = context;
  if (phase === 'playback') return { id: 'revealed', label: 'Round revealed' };
  if (complete(context)) {
    const winner = duel.result?.winner;
    if (winner === null) return { id: 'draw', label: 'A draw' };
    if (context.mode === 'hotseat') return { id: 'victory', label: `${fighterName(duel, winner)} wins` };
    return winner === viewer ? { id: 'victory', label: 'Victory' } : { id: 'defeat', label: 'Defeat' };
  }
  if (isOnline(context) && offline) return { id: 'reconnecting', label: 'Reconnecting…' };
  if (busy) return { id: 'sending', label: 'Sending your choice…' };
  if (pending[viewer]) return { id: 'locked', label: 'Choice locked' };
  if (phase === 'review') return { id: 'review', label: 'Round complete' };
  return { id: 'choosing', label: 'Choose a move' };
}

export function fighterReadiness(index, context = {}) {
  const { duel, phase = 'select', viewer = 0, pending = [false, false], busy = false, offline = false } = context;
  if (phase === 'playback') return 'Choices revealed';
  if (complete(context)) return duel.result?.winner === null ? 'Draw' : duel.result?.winner === index ? 'Winner' : 'Defeated';
  if (isOnline(context) && offline && index === viewer) return 'Reconnecting…';
  if (busy && index === viewer) return 'Sending choice…';
  if (pending[index]) return 'Choice locked';
  if (phase === 'review') return 'Round complete';
  if (context.mode === 'cpu' && index !== viewer) return 'Ready';
  return index === viewer ? 'Choosing a move' : 'Waiting for a choice';
}

/** Summarize only the server/rules result, never an unrevealed selection. */
export function roundSummary(duel) {
  const events = duel?.lastRound?.events;
  if (!Array.isArray(events)) return 'Choose a move. Both choices reveal together.';
  const moves = events.flatMap(event => {
    if (event.actor !== 0 && event.actor !== 1) return [];
    const name = fighterName(duel, event.actor);
    if (event.type === 'attack') return [`${name} ${event.counter ? 'countered for' : 'dealt'} ${event.damage} damage${event.parried ? ' after a parry' : ''}`];
    if (event.type === 'riposte') return [`${name} readied Riposte`];
    if (event.type === 'riposte-miss') return [`${name}'s Riposte found no opening`];
    if (event.type === 'guard') return [`${name} guarded`];
    if (event.type === 'recover') return [`${name} restored ${event.restored} stamina`];
    if (event.type === 'skipped') return [`${name} was defeated before acting`];
    return [];
  });
  if (moves.length) return `${moves.join('; ')}.`;
  return events.find(event => event.type === 'result')?.text || 'Both choices reveal together.';
}

/** All numbers come from the authoritative option; Guard never implies zero damage. */
export function actionPreview(option) {
  if (option.statusEffect === 'entangle') return {
    label: `${option.damage} damage + net`,
    detail: `Next-round attacks +3 SP · Guard prevents the net · Guard or Recover clears it · ${option.guardedDamage} damage against Guard`,
  };
  if (option.conditional === 'riposte') return {
    label: `Counter: ${option.damage} damage`,
    detail: 'Halves an incoming Strike · Counter only if you survive · Techniques, Guard and Recover prevent the counter',
  };
  if (option.id === 'recover') return {
    label: `Up to +${option.recovery} SP`,
    detail: 'Acts last · Capped at maximum stamina',
  };
  if (option.id === 'guard') return {
    label: 'Block most damage',
    detail: `${Math.round(RULES.GUARD_REDUCTION * 100)}% reduction · Minimum 1 damage · Some techniques bypass Guard`,
  };
  return {
    label: `${option.damage} damage`,
    detail: `Against an unguarded rival${Number.isFinite(option.guardedDamage) ? ` · ${option.guardedDamage} against Guard` : ''}`,
  };
}

export function outcomeReason(duel, viewer = 0) {
  const result = duel?.result;
  if (!result) return 'The duel is still in progress.';
  if (result.reason === 'forfeit') return result.winner === viewer
    ? 'Your rival forfeited or failed to reconnect.'
    : 'You forfeited or failed to reconnect.';
  if (result.reason === 'abandoned') return 'Both fighters left the duel. No victory was awarded.';
  if (result.reason === 'draw') return 'The round limit was reached with equal health and stamina proportions.';
  if (result.reason === 'round-limit') return 'The round limit was reached. Remaining health proportion, then stamina, decided the duel.';
  return result.winner === viewer ? 'Your rival was defeated.' : 'You were defeated.';
}
