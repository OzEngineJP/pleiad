import { randomUUID } from 'node:crypto';
import { isModelId, normalizeModels } from '../compat-endpoints.mjs';

const PURPOSE = 'conversation';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// The initial Plus proxy advertises its built-in conversation model through configuration.
const BUILT_IN_MODELS = [{ id: 'qwen/qwen3.8-27b', reasoning_efforts: ['low', 'medium', 'high'] }];

export function createPlusModelConnection({ apiBase, client, cloud = false, runtime = {} }) {
  return {
    url: new URL(apiBase + '/v1/chat/completions'),
    async models(signal) {
      let rows;
      try {
        const response = await client.request('GET', '/v1/models', {
          auth: false, signal: AbortSignal.any([AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]),
          redirect: 'error',
        });
        rows = response?.data;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error.status !== 404 && error.status !== 405) throw error;
        rows = BUILT_IN_MODELS;
      }
      const { ids, info } = normalizeModels(rows);
      return Object.fromEntries(ids.map(id => {
        const advertised = rows.find(row => row?.id === id);
        const efforts = Array.isArray(advertised?.reasoning_efforts)
          ? ['minimal', 'low', 'medium', 'high'].filter(value => advertised.reasoning_efforts.includes(value))
          : [];
        return [id, { ...info[id], label: info[id]?.name ?? id, efforts }];
      }));
    },
    async authorization(model, signal) {
      if (!isModelId(model)) throw new Error('Invalid Plus model');
      signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const options = { signal, redirect: 'error' };
      const tenantId = cloud ? runtime.tenantId : (await client.request('GET', '/v1/tenants', options))
        ?.tenants?.find(row => row?.kind === 'personal')?.id;
      if (!UUID.test(tenantId ?? '')) throw new Error('Missing Plus model workspace');
      let resource = '/v1/model-tickets';
      const body = { tenantId, model, purpose: PURPOSE };
      if (cloud) {
        const { cloudHostId, generation, token } = runtime;
        if (!UUID.test(cloudHostId ?? '') || !Number.isSafeInteger(generation) || generation < 1 ||
            !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw new Error('Missing Plus cloud runtime configuration');
        resource = '/v1/cloud-runtime/model-tickets';
        Object.assign(body, { cloudHostId, generation });
        Object.assign(options, { auth: false, headers: { authorization: 'Bearer ' + token } });
      }
      const reply = await client.request('POST', resource, { ...options, body });
      if (typeof reply?.ticket !== 'string' || !/^[!-~]{1,8192}$/.test(reply.ticket) ||
          !Number.isFinite(Date.parse(reply.expiresAt)) || Date.parse(reply.expiresAt) <= Date.now()) {
        throw new Error('Invalid Plus model ticket');
      }
      return {
        key: reply.ticket,
        headers: { 'x-pleiad-tenant': tenantId, 'x-pleiad-model-purpose': PURPOSE, 'x-request-id': randomUUID() },
      };
    },
  };
}
