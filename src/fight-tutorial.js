import { createDuel, resolveRound, getActionOptions, WEAPONS, ARMORS } from './combat.js';
import { normalizePresetAppearance } from './face-presets.js';
import { preloadCleanArt, prepareCleanAvatar } from './current-avatar.js';
import { renderArena } from './arena.js';
import { actionPreview, roundSummary } from './battle-presentation.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const lessons = Object.freeze([
  Object.freeze({ action: 'guard', opponentAction: 'strike', title: 'Meet a Strike with Guard', instruction: 'The instructor will Strike. Choose Guard to reduce its damage by 65%. Guard acts before attacks, but still lets some damage through.' }),
  Object.freeze({ action: 'technique', opponentAction: 'guard', title: 'Read the weapon technique', instruction: 'The instructor will Guard. Your sword’s Feint ignores Guard and half of armor protection. Techniques differ with each weapon: check their effects before choosing.' }),
  Object.freeze({ action: 'recover', opponentAction: 'technique', title: 'Recover at the right moment', instruction: 'The instructor will ready dagger Riposte. It counters an ordinary Strike. Choose Recover to restore stamina without triggering that counter. Recover acts last, so an attacking rival could still hurt you.' }),
]);

/** Disposable practice figures. Creating a lesson never accepts or touches a saved fighter. */
export function createFightTutorial() {
  const character = (name, sex, facePreset, color) => ({ name, color,
    stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced',
    appearance: normalizePresetAppearance({ sex, facePreset, skin: 'ivory', hairColor: 'chestnut' }),
  });
  const duel = createDuel([
    { character: character('Learner', 'male', 'p05', '#9e493b'), weapon: 'sword', armor: 'medium', helmet: 'none' },
    { character: character('Instructor', 'female', 'p10', '#436f70'), weapon: 'dagger', armor: 'medium', helmet: 'none' },
  ]);
  return { step: 0, phase: 'choose', duel, feedback: '' };
}

function checkTutorial(state) {
  if (!state || !Number.isInteger(state.step) || state.step < 0 || state.step >= lessons.length
    || !['choose', 'review', 'complete'].includes(state.phase) || !state.duel) throw new Error('Invalid tutorial state.');
}

function lessonFeedback(state, duel) {
  const events = duel.lastRound.events;
  if (state.step === 0) {
    const attack = events.find(event => event.type === 'attack' && event.actor === 1);
    const strike = getActionOptions(state.duel, 1).find(option => option.id === 'strike');
    return `Guard reduced the instructor’s Strike from ${strike.damage} to ${attack.damage} damage. You spent ${getActionOptions(state.duel, 0).find(option => option.id === 'guard').cost} stamina. Watch both health and stamina.`;
  }
  if (state.step === 1) {
    const attack = events.find(event => event.type === 'attack' && event.actor === 0);
    return `Your Feint dealt ${attack.damage} damage through Guard. This is a sword effect: other techniques have their own strengths, costs and counters.`;
  }
  const restored = events.find(event => event.type === 'recover' && event.actor === 0).restored;
  return `You restored ${restored} stamina. Riposte found no Strike to counter, so neither fighter took damage. A technique or Guard also prevents its counter.`;
}

/** Each accepted move resolves once through the same rules as a real duel. */
export function advanceFightTutorial(state, action) {
  checkTutorial(state);
  if (state.phase === 'complete') return state;
  if (action === 'next') {
    if (state.phase !== 'review') return state;
    return state.step === lessons.length - 1
      ? { ...state, phase: 'complete' }
      : { ...state, step: state.step + 1, phase: 'choose', feedback: '' };
  }
  const lesson = lessons[state.step];
  if (state.phase !== 'choose' || action !== lesson.action) return state;
  const duel = resolveRound(state.duel, [action, lesson.opponentAction]);
  return { ...state, phase: 'review', duel, feedback: lessonFeedback(state, duel) };
}

/** Prepare the normal renderer; the tutorial adds no new artwork or appearance conversion. */
export async function prepareFightTutorial(state) {
  checkTutorial(state);
  await preloadCleanArt();
  await Promise.all(state.duel.fighters.map(fighter => prepareCleanAvatar(fighter.character.appearance, 'battle', {
    weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet,
  })));
}

function fighterStatus(fighter, index) {
  const name = escape(fighter.character.name);
  return `<section class="tutorial-fighter-status" aria-label="${name} status"><div><h2>${name}</h2><span>${index === 0 ? 'Your move' : 'Coached rival'}</span></div><p>${escape(WEAPONS[fighter.weapon].name)} · ${escape(ARMORS[fighter.armor].name)}</p><div class="meter-label"><span>Health</span><strong>${fighter.hp} / ${fighter.maxHp}</strong></div><progress class="meter health" max="${fighter.maxHp}" value="${fighter.hp}" aria-label="${name} health"></progress><div class="meter-label"><span>Stamina</span><strong>${fighter.stamina} / ${fighter.maxStamina}</strong></div><progress class="meter stamina" max="${fighter.maxStamina}" value="${fighter.stamina}" aria-label="${name} stamina"></progress></section>`;
}

/** The root app owns routing and optional playback. No timer, network or persistent state. */
export function renderFightTutorial(state, { playing = false } = {}) {
  checkTutorial(state);
  const lesson = lessons[state.step];
  const complete = state.phase === 'complete';
  const option = getActionOptions(state.duel, 0).find(item => item.id === lesson.action);
  const preview = actionPreview(option);
  const displayedRound = state.phase === 'choose' ? state.duel.round : state.duel.lastRound?.round ?? state.duel.round;
  const controls = complete
    ? '<div class="tutorial-completion-actions"><button type="button" class="button primary" data-action="menu-fight">Fight</button><button type="button" class="button secondary" data-action="menu-quick-duel">Quick Duel</button><button type="button" class="button ghost" data-action="tutorial-restart">Repeat lessons</button></div>'
    : state.phase === 'review'
      ? `<button type="button" class="button primary" data-action="tutorial-next" ${playing ? 'disabled' : ''}>${state.step === lessons.length - 1 ? 'Finish lessons' : 'Next lesson'}</button>`
      : `<button type="button" class="button primary tutorial-guided-move" data-action="tutorial-move" data-value="${lesson.action}" ${playing ? 'disabled' : ''}><strong>${escape(option.name)}</strong><span>${option.cost ? `${option.cost} stamina` : 'No stamina cost'} · ${escape(preview.label)}</span></button>`;
  return `<section class="fight-tutorial" aria-labelledby="tutorial-title"><nav class="tutorial-navigation" aria-label="Tutorial navigation"><button type="button" class="button ghost" data-action="menu-home">Main menu</button><span>Practice · No time limit</span></nav><header class="tutorial-heading"><span class="eyebrow">Learn to fight · ${complete ? 'Complete' : `Lesson ${state.step + 1} of ${lessons.length}`}</span><h1 id="tutorial-title">${complete ? 'Ready for the arena' : escape(lesson.title)}</h1><p>${complete ? 'Read the rival’s equipment, plan your stamina and choose your move. In a real duel, both choices are secret until they reveal together.' : escape(lesson.instruction)}</p></header><div class="tutorial-layout"><div class="tutorial-arena-panel"><div class="arena-stage tutorial-arena">${renderArena({ ...state.duel, round: displayedRound }, { fit: 'meet' })}</div><div class="tutorial-status-pair">${state.duel.fighters.map(fighterStatus).join('')}</div></div><aside class="tutorial-coach" aria-label="Your lesson"><h2>${complete ? 'Three moves to remember' : state.phase === 'review' ? 'What happened' : 'Try this move'}</h2>${complete ? '<ul class="tutorial-recap"><li><strong>Guard</strong> reduces ordinary Strikes and many techniques.</li><li><strong>Weapon techniques</strong> have specific effects and counters.</li><li><strong>Recover</strong> restores stamina, but leaves you open to attacks.</li></ul>' : state.phase === 'review' ? `<p class="tutorial-feedback" role="status">${escape(state.feedback)}</p><p class="tutorial-round-summary">${escape(roundSummary(state.duel))}</p>` : `<p>${escape(preview.detail)}</p><p class="tutorial-predictable-rival">Instructor’s next move: <strong>${escape(getActionOptions(state.duel, 1).find(item => item.id === lesson.opponentAction).name)}</strong></p>`}${playing ? '<p class="tutorial-playback-status" role="status">Watching the round…</p>' : ''}${controls}</aside></div></section>`;
}
