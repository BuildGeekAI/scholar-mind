import { afterEach, describe, expect, it, vi } from 'vitest';
import { processPapers, streamChat } from '../services/api';

/**
 * The client parses server-sent events by hand. Network chunk boundaries fall
 * wherever TCP puts them, so a frame split mid-line has to survive — this is
 * exactly the class of bug that shows up only under load.
 */
const respondWith = (chunks: string[]) => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream, { status: 200 }))
  );
};

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

afterEach(() => vi.unstubAllGlobals());

/**
 * The parser cases live on `streamChat` now. Processing no longer streams —
 * a queued run outlives the request that started it — but chat still does, so
 * the frame handling these cases exist to protect is still in use.
 */
describe('the SSE frame parser', () => {
  it('delivers one callback per frame, in order', async () => {
    respondWith([
      frame('delta', { text: 'a' }),
      frame('delta', { text: 'b' }),
      frame('done', { grounded: false }),
    ]);
    const seen: string[] = [];
    const done = vi.fn();
    await streamChat('p1', 'q', false, t => seen.push(t), done);
    expect(seen).toEqual(['a', 'b']);
    expect(done).toHaveBeenCalledOnce();
  });

  it('reassembles a frame split across network chunks', async () => {
    const whole = frame('delta', { text: 'split' });
    respondWith([whole.slice(0, 12), whole.slice(12, 20), whole.slice(20), frame('done', {})]);
    const seen: string[] = [];
    await streamChat('p1', 'q', false, t => seen.push(t));
    expect(seen).toEqual(['split']);
  });

  it('delivers frames that arrive glued into one chunk', async () => {
    respondWith([frame('delta', { text: 'a' }) + frame('delta', { text: 'b' }) + frame('done', {})]);
    const seen: string[] = [];
    await streamChat('p1', 'q', false, t => seen.push(t));
    expect(seen).toEqual(['a', 'b']);
  });

  it('keeps streaming after a malformed frame', async () => {
    respondWith([
      'event: delta\ndata: {not json\n\n',
      frame('delta', { text: 'survivor' }),
      frame('done', {}),
    ]);
    const seen: string[] = [];
    const done = vi.fn();
    await streamChat('p1', 'q', false, t => seen.push(t), done);
    expect(seen).toEqual(['survivor']);
    expect(done).toHaveBeenCalledOnce();
  });

  it('routes error frames to the error handler, not the content handler', async () => {
    respondWith([frame('error', { message: 'Chat failed' })]);
    const onDelta = vi.fn();
    const onError = vi.fn();
    await streamChat('p1', 'q', false, onDelta, undefined, onError);
    expect(onDelta).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Chat failed');
  });

  it('rejects on a non-OK response instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(streamChat('p1', 'q', false, () => {})).rejects.toThrow(/500/);
  });
});

/**
 * Processing is an enqueue now: the request records the intent and returns a run
 * id, and the client polls that. What matters is the request body and that a
 * refusal surfaces rather than resolving to nothing.
 */
describe('processPapers', () => {
  const respondJson = (body: unknown, status = 202) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    );

  it('sends the paper ids and the pipeline mode, and returns the run', async () => {
    respondJson({ runId: 'run-1', enqueued: 1, skipped: 0 });
    const result = await processPapers('p1', ['x'], 'index');
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ paperIds: ['x'], mode: 'index' });
    expect(result.runId).toBe('run-1');
  });

  it('reports work that was already in flight rather than duplicating it', async () => {
    respondJson({ runId: 'run-1', enqueued: 0, skipped: 2, alreadyRunning: true });
    const result = await processPapers('p1', ['x', 'y'], 'index');
    expect(result.alreadyRunning).toBe(true);
    expect(result.enqueued).toBe(0);
  });

  it('rejects on a non-OK response instead of resolving to nothing', async () => {
    respondJson({ error: 'No papers selected' }, 400);
    await expect(processPapers('p1', [], 'index')).rejects.toThrow(/No papers selected/);
  });
});

describe('streamChat', () => {
  it('accumulates deltas and reports citations separately', async () => {
    respondWith([
      frame('delta', { text: 'Multi-head ' }),
      frame('delta', { text: 'attention.' }),
      frame('citations', { citations: [{ fileName: 'Attention', documentUri: 'u', snippet: 's' }] }),
      frame('done', { grounded: true, indexed: 3, pending: 0 }),
    ]);

    let text = '';
    const onCitations = vi.fn();
    const onDone = vi.fn();
    await streamChat('p1', 'q', false, d => (text += d), onDone, undefined, onCitations);

    expect(text).toBe('Multi-head attention.');
    expect(onCitations).toHaveBeenCalledWith([
      { fileName: 'Attention', documentUri: 'u', snippet: 's' },
    ]);
    expect(onDone).toHaveBeenCalledWith({ grounded: true, indexed: 3, pending: 0 });
  });

  it('tolerates a delta frame with no text field', async () => {
    respondWith([frame('delta', {}), frame('delta', { text: 'ok' }), frame('done', {})]);
    let text = '';
    await streamChat('p1', 'q', false, d => (text += d));
    expect(text).toBe('ok');
  });
});
