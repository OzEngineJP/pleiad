import { t } from '../i18n.mjs';

// Read before registering backends. Settings and subsequent environment changes
// cannot alter the policy of a running server.
const kind = process.env.AGENT_HOST_KIND;
if (kind !== undefined && kind !== 'cloud') throw new Error('AGENT_HOST_KIND must be cloud or unset');

export const managedBackendIds = kind === 'cloud' ? Object.freeze(['pleiad-agent']) : null;

export function backendAllowed(id) {
  return managedBackendIds === null || managedBackendIds.includes(id);
}

export function assertBackendAllowed(id) {
  if (typeof id === 'string' && id && !backendAllowed(id)) {
    throw Object.assign(new Error(t('agents.managedBackendDenied', { id })), { code: 'MANAGED_BACKEND_DENIED' });
  }
}
