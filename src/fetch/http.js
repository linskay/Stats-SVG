import axios from 'axios';
import pkg from 'http2-wrapper';

const { http2Adapter } = pkg;

// Leave a small portion of the request budget for data processing and rendering.
export const REQUEST_DEADLINE_MS = 9_000;
const UPSTREAM_TIMEOUT_MS = 7_000;

export class UpstreamRequestError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamRequestError';
    this.status = status;
  }
}

export function createRequestDeadline(timeoutMs = REQUEST_DEADLINE_MS) {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error('Request deadline exceeded')), timeoutMs);

  return {
    signal: controller.signal,
    remaining() {
      return Math.max(0, expiresAt - Date.now());
    },
    throwIfExpired() {
      if (controller.signal.aborted || Date.now() >= expiresAt) {
        throw new UpstreamRequestError('Request processing deadline exceeded', { status: 504 });
      }
    },
    dispose() {
      clearTimeout(timer);
    }
  };
}

function createClient(options) {
  return axios.create({
    timeout: UPSTREAM_TIMEOUT_MS,
    ...options
  });
}

export const githubClient = createClient({ adapter: http2Adapter });
export const leetcodeClient = createClient();
export const steamClient = createClient();

export async function upstreamRequest(client, request, deadline, serviceName) {
  const timeout = Math.min(client.defaults.timeout, deadline.remaining());
  if (deadline.signal.aborted || timeout <= 0) {
    throw new UpstreamRequestError('Request processing deadline exceeded', { status: 504 });
  }

  try {
    return await client.request({ ...request, signal: deadline.signal, timeout });
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new UpstreamRequestError('Request processing deadline exceeded', { status: 504, cause: error });
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || axios.isCancel(error)) {
      throw new UpstreamRequestError(`${serviceName} is temporarily unavailable`, { status: 503, cause: error });
    }

    throw error;
  }
}
