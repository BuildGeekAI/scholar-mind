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

describe('processPapers', () => {
  it('delivers one callback per paper frame, in order', async () => {
    respondWith([
      frame('paper', { id: 'a', status: 'processing' }),
      frame('paper', { id: 'b', status: 'converted' }),
      frame('done', {}),
    ]);
    const seen: string[] = [];
    const done = vi.fn();
    await processPapers('p1', ['a', 'b'], 'index', p => seen.push(p.id), done);
    expect(seen).toEqual(['a', 'b']);
    expect(done).toHaveBeenCalledOnce();
  });

  it('reassembles a frame split across network chunks', async () => {
    const whole = frame('paper', { id: 'split', status: 'converted' });
    respondWith([whole.slice(0, 12), whole.slice(12, 30), whole.slice(30), frame('done', {})]);
    const seen: string[] = [];
    await processPapers('p1', ['split'], 'index', p => seen.push(p.id));
    expect(seen).toEqual(['split']);
  });

  it('delivers frames that arrive glued into one chunk', async () => {
    respondWith([frame('paper', { id: 'a' }) + frame('paper', { id: 'b' }) + frame('done', {})]);
    const seen: string[] = [];
    await processPapers('p1', [], 'index', p => seen.push(p.id));
    expect(seen).toEqual(['a', 'b']);
  });

  it('keeps streaming after a malformed frame', async () => {
    respondWith([
      'event: paper\ndata: {not json\n\n',
      frame('paper', { id: 'survivor' }),
      frame('done', {}),
    ]);
    const seen: string[] = [];
    const done = vi.fn();
    await processPapers('p1', [], 'index', p => seen.push(p.id), done);
    expect(seen).toEqual(['survivor']);
    expect(done).toHaveBeenCalledOnce();
  });

  it('routes error frames to the error handler, not the paper handler', async () => {
    respondWith([frame('error', { message: 'Processing failed' })]);
    const onPaper = vi.fn();
    const onError = vi.fn();
    await processPapers('p1', [], 'artifacts', onPaper, undefined, onError);
    expect(onPaper).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Processing failed');
  });

  it('sends the pipeline mode to the server', async () => {
    respondWith([frame('done', {})]);
    await processPapers('p1', ['x'], 'index', () => {});
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ paperIds: ['x'], mode: 'index' });
  });

  it('rejects on a non-OK response instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(processPapers('p1', ['x'], 'index', () => {})).rejects.toThrow(/500/);
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
