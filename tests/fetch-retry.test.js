import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRetry } from '../src/fetch-retry.js';

const resp = (status) => ({ status, ok: status < 400 });
const econnreset = () => Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });

afterEach(() => vi.unstubAllGlobals());

describe('fetchRetry', () => {
  it('retries a dropped connection, then returns the success', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(econnreset())
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchRetry('https://x', {}, { tries: 4 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 502, then returns the recovered 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp(502))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchRetry('https://x', {}, { tries: 4 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hands back the final 5xx so the caller can throw its own error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(503));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchRetry('https://x', {}, { tries: 3 });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // exhausted, not infinite
  });

  it('throws the last error when every attempt fails at the socket', async () => {
    const fetchMock = vi.fn().mockRejectedValue(econnreset());
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRetry('https://x', {}, { tries: 3 })).rejects.toThrow('socket reset');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 2xx or a non-retryable 4xx', async () => {
    const ok = vi.fn().mockResolvedValue(resp(200));
    vi.stubGlobal('fetch', ok);
    expect((await fetchRetry('https://x')).status).toBe(200);
    expect(ok).toHaveBeenCalledTimes(1);

    const notFound = vi.fn().mockResolvedValue(resp(404));
    vi.stubGlobal('fetch', notFound);
    expect((await fetchRetry('https://x', {}, { tries: 4 })).status).toBe(404);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
