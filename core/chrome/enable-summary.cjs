'use strict';

// Only protocol states and counters belong in logs, never Chrome titles or URLs.
function enableStepSummary(step) {
  const summary = {};
  for (const key of ['state', 'reason', 'checked', 'scanVisited', 'scanWebAreas', 'scanDepth']) {
    if (typeof step?.[key] === 'boolean' || typeof step?.[key] === 'number' ||
        (typeof step?.[key] === 'string' && /^[a-z-]{1,64}$/.test(step[key]))) summary[key] = step[key];
  }
  return summary;
}

module.exports = { enableStepSummary };
