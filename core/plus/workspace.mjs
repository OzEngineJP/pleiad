import { createHash } from 'node:crypto';
import { OpError, stableStringify } from '../ops/registry.mjs';
import { PlusError } from './client.mjs';

export function createWorkspaceOperations({ session, workspaceOf }) {
  async function request(path, body, headers) {
    try {
      return await session.client.request('POST', path, { body, headers });
    } catch (error) {
      if (!(error instanceof PlusError)) throw error;
      const code = {
        unauthenticated: 'WORKSPACE_SIGN_IN_REQUIRED',
        no_personal_workspace: 'NO_PERSONAL_WORKSPACE',
      }[error.code] ?? ({
        400: 'INVALID',
        403: 'WORKSPACE_FORBIDDEN',
        404: 'NOT_FOUND',
        409: error.message === 'request_id_reused' ? 'REQUEST_ID_REUSED' : 'WORKSPACE_CONFLICT',
      })[error.status] ?? 'WORKSPACE_UNAVAILABLE';
      throw new OpError(code, error.status === 409 && code === 'WORKSPACE_CONFLICT'
        ? 'The page or block changed. Run workspace.readPage before editing again.'
        : error.message);
    }
  }

  return {
    async prepare(sessionId, op, input) {
      const { signedIn, uid } = await session.status({ refresh: false });
      if (!signedIn || !uid) throw new OpError('WORKSPACE_SIGN_IN_REQUIRED', 'Sign in to use workspace operations.');
      const workspace = await workspaceOf(sessionId);
      if (!workspace) throw new OpError('NOT_FOUND', 'Conversation not found.');
      const sessionRef = createHash('sha256').update(sessionId).digest('hex');
      const digest = createHash('sha256').update(stableStringify(JSON.parse(JSON.stringify(input)))).digest('hex');
      const grant = await request('/v1/workspace-agent/grant', {
        workspace, sessionRef, op, digest, targetId: input.pageId ?? input.databaseId ?? null, expectedUid: uid,
      });
      return { ...grant, uid };
    },
    execute(op, input, { tenantId, ticket }) {
      return request('/v1/tenants/' + encodeURIComponent(tenantId) + '/workspace-agent/' + op,
        input, { 'x-pleiad-workspace-grant': ticket });
    },
  };
}
