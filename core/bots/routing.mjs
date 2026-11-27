import { candidateId, EFFORT_LEVELS, LEVEL_ID, parseCandidate } from '../delegation-routing.mjs';
import { modePosition, resolveDelegatedMode } from '../modes.mjs';

export function resolveBotRoutingMode(mode, parent, child) {
  const parentModes = parent?.modes();
  const childModes = child?.modes();
  if (!parentModes?.[mode] || !childModes) return null;
  if (parent.id === child.id) return mode;
  const decision = resolveDelegatedMode({ parentMode: mode, parentModes, childModes });
  if (!decision.mode || decision.escalation) return null;
  if (modePosition(parentModes[mode]).enforced && !modePosition(childModes[decision.mode]).enforced) return null;
  return decision.mode;
}

export function botRoutingDefaults(bot) {
  const id = 'level_1';
  const candidate = candidateId(bot.backend, bot.model || null, bot.account, bot.endpoint);
  return {
    levels: [{ id, name: '' }], tiers: { [id]: [candidate] },
    efforts: { [id]: bot.effort ? { [candidate]: bot.effort } : {} },
  };
}

export const botRoutingSettings = bot => bot.routing ?? botRoutingDefaults(bot);
export const botCandidates = settings => settings.levels.flatMap(({ id }) => settings.tiers[id] ?? []);

export function updateBotRouting(bot, patch) {
  const next = { ...bot, ...patch };
  if (!bot.routing || !['backend', 'model', 'effort', 'account', 'endpoint'].some(key => next[key] !== bot[key])) return next;
  const routing = structuredClone(bot.routing);
  const level = routing.levels.find(({ id }) => routing.tiers[id].length).id;
  const previous = routing.tiers[level][0];
  const replacement = candidateId(next.backend, next.model || null, next.account, next.endpoint);
  const alternatives = routing.tiers[level].slice(1).filter(id => id !== replacement);
  routing.tiers[level] = [replacement, ...alternatives];
  delete routing.efforts[level][previous];
  routing.efforts[level][replacement] = next.effort || '';
  return { ...next, routing };
}

export function validateBotRouting(input) {
  if (!Array.isArray(input?.levels) || !input.levels.length || input.levels.length > 10) return null;
  const levels = [], tiers = {}, efforts = {};
  const seen = new Set();
  for (const level of input.levels) {
    const id = level?.id;
    if (typeof id !== 'string' || !LEVEL_ID.test(id) || Object.hasOwn(Object.prototype, id) || seen.has(id)
      || typeof level.name !== 'string' || level.name.length > 80) return null;
    const candidates = input.tiers?.[id] ?? [];
    if (!Array.isArray(candidates) || candidates.length > 20 || new Set(candidates).size !== candidates.length
      || candidates.some(c => !parseCandidate(c, { allowDefault: true }))) return null;
    const strength = Object.entries(input.efforts?.[id] ?? {}).filter(([key]) => key === '*' || candidates.includes(key));
    if (strength.some(([, value]) => value !== '' && !EFFORT_LEVELS.includes(value))) return null;
    levels.push({ id, name: level.name });
    seen.add(id);
    tiers[id] = [...candidates];
    efforts[id] = Object.fromEntries(strength);
  }
  return Object.values(tiers).some(list => list.length) ? { levels, tiers, efforts } : null;
}
