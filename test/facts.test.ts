import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messagesModel, type CallFact, type Model } from '../server/coworld.ts';
import { act } from '../server/operator.ts';
import { Ledger, measure, pictureTokens, type StepFacts } from '../src/agent/facts.ts';

let now = 0;
const at = (ms: number) => (now = ms);

describe('the record of what the agent does (its model calls, and vision, touch, tools, the loop)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a step as it happens: pictures, the calls as the server measured them, its moves, and when each part was', () => {
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const ledger = new Ledger();
    const seen: StepFacts[] = [];
    ledger.on((e) => 'step' in e && seen.push(e.step));

    at(1000);
    ledger.begin();
    ledger.picture(768, 512);
    ledger.picture(768, 768, 2);
    at(1100);
    ledger.sent();
    at(9100);
    // A retry: two calls, back to back, the last ending when the answer came.
    ledger.answered([
      { prefill: 9000, cached: 900, output: 30, dur_ms: 1500 },
      { prefill: 9100, cached: 900, output: 400, dur_ms: 6000 },
    ]);
    const done = ledger.move('set', 'Temperature', 0.25);
    at(9900);
    done('set "Temperature" to 12');
    ledger.move('press', 'Auto', 1)('pressed "Auto"');
    at(12_100);
    ledger.end();

    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.calls.map((c) => [c.t, c.dur_ms])).toEqual([[1600, 1500], [3100, 6000]]);
    expect(s.pictures.map((p) => p.tokens)).toEqual([pictureTokens(768, 512), pictureTokens(768, 768)]);
    expect(pictureTokens(768, 512)).toBe(525);
    expect(s.moves.map((m) => [m.name, m.t, m.done, m.travel, m.tokens])).toEqual([['set', 9100, 9900, 0.25, 6], ['press', 9900, 9900, 1, 4]]);

    const m = measure([s]);
    expect(m).toMatchObject({ steps: 1, span_ms: 11_100 });
    expect(m.tokens).toMatchObject({ read: 18_100, cached: 1800, wrote: 430, thinking_ms: 7500 });
    expect(m.tokens.writeRate).toBeCloseTo(430 / 7.5);
    expect(m.vision).toMatchObject({ pictures: 2, tokens: 525 + 787, zoom: 2 });
    expect(m.vision.share).toBeCloseTo((525 + 787) / 16_300);
    expect(m.touch).toMatchObject({ moves: 2, travel: 1.25, handsOn_ms: 800 });
    expect(m.tools).toMatchObject({ calls: 2, mean_ms: 400, resultTokens: 10 });
    expect(m.loop).toEqual({ looking_ms: 100, thinking_ms: 8000, acting_ms: 3000 });
    // A request's steps, together.
    expect(ledger.request).toEqual([s]);
    const both = measure([s, { ...s, t: 13_000, end: 20_000 }]);
    expect(both).toMatchObject({ steps: 2, span_ms: 19_000, tools: { calls: 4 }, touch: { travel: 2.5 } });
    ledger.newRequest();
    expect(ledger.request).toEqual([]);
  });

  it('keeps no step the model never answered, and says when the agent wakes or fails', () => {
    const ledger = new Ledger();
    const events: unknown[] = [];
    ledger.on((e) => events.push(e));
    ledger.begin();
    ledger.end();
    ledger.setPresence('waking');
    ledger.setPresence('waking');
    ledger.setPresence('failed');
    expect(ledger.steps).toEqual([]);
    expect(events.map((e) => (e as { presence: string }).presence)).toEqual(['waking', 'failed']);
  });
});

describe('measuring the model', () => {
  it('a step carries each call it took, retries too', async () => {
    let n = 0;
    const model: Model = async (_system, _user, meter) => {
      meter?.({ prefill: 100 + n, cached: 10, output: 5, dur_ms: 50 });
      return n++ === 0 ? 'not json' : JSON.stringify({ say: 'ok', look: null, actions: [], done: true, rework: null });
    };
    const step = await act(model, { request: 'r', page: '/', controls: '', images: [], history: [], player: [], changes: [] });
    expect(step.calls).toEqual([
      { prefill: 100, cached: 10, output: 5, dur_ms: 50 },
      { prefill: 101, cached: 10, output: 5, dur_ms: 50 },
    ]);
  });

  it('reads the usage the Messages API reports: everything read (input, cache writes, cache reads), the cache reads, the output', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 800, output_tokens: 42 } }));
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const calls: CallFact[] = [];
    const reply = await messagesModel(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'k')('sys', 'hello', (c) => calls.push(c));
    server.close();
    expect(reply).toBe('hi');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prefill: 950, cached: 800, output: 42 });
    expect(calls[0]!.dur_ms).toBeGreaterThanOrEqual(0);
  });
});
