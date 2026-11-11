/**
 * Your agent's panel, on any site with Connect:
 * - Chat: ask it for something and watch it work; tell it things while it works (typed, or said aloud).
 * - Coach: teach it (coach.ts): do it yourself and talk it through, type notes, mark moments, ask it and correct it.
 *   Finishing proposes changes to its policy that cite what you did; the ones you keep make a new version, which
 *   practices against the one it follows now on photos it hasn't seen (practice.ts), and you keep the better one.
 * - Policy: every version of what it knows about this site, and the one it follows.
 */
import type { CodeChange, ConnectApi, Layer, Practice, PolicyState, PolicyVersion, Site } from '../api.ts';
import { h, iconEl } from '../dom.ts';
import { icon } from '../icons.ts';
import { Coach } from './coach.ts';
import { measure } from './facts.ts';
import { Operator, type Line } from './operator.ts';
import { practice, type PracticeProgress } from './practice.ts';
import { boxOf, Presence } from './presence.ts';
import { canListen, listen, type Listening } from './voice-input.ts';

const LAYERS: Layer[] = ['situation', 'belief', 'goal', 'skill', 'strategy', 'execution', 'update'];
const MUTED_KEY = 'softmax-connect:muted';

type Tab = 'chat' | 'policy';
/** Practice, shown in Policy while it runs and after. */
type Stage = 'idle' | 'practicing' | 'results';
/** Teaching (the grad cap): off, asking for the screen, on, or learning from it. */
export type Teach = 'off' | 'starting' | 'on' | 'training';

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createAgent(opts: { api: ConnectApi; site: Site; page: string; shadow: ShadowRoot; render: () => void }) {
  const { api, site, page, shadow, render } = opts;
  const s = {
    tab: 'chat' as Tab,
    /** "Measured" (what its last step measurably was) is open. */
    measured: false,
    lines: [] as Line[],
    busy: null as string | null,
    changes: [] as CodeChange[],
    muted: localStorage.getItem(MUTED_KEY) === '1',
    policy: null as PolicyState | null,
    stage: 'idle' as Stage,
    practice: null as Practice | null,
    progress: null as PracticeProgress | null,
    error: null as string | null,
    viewing: null as string | null,
    hearing: '',
  };

  // The bubble sits by the agent's place in the nav; with the panel open there's no bubble: it talks in the panel.
  const presence = new Presence(shadow, () => shadow.querySelector<HTMLElement>('.item.agent'));
  presence.setMuted(s.muted);
  presence.panelOpen = () => !!shadow.querySelector('.agent-panel');
  /** What it's saying now, typing out at the foot of the conversation in step with its voice (the panel's bubble). */
  const live = h('li', { class: 'line agent live', 'aria-live': 'polite' });
  let liveText: string | null = null;
  presence.onLive = (text, shown) => {
    if (text !== liveText) {
      liveText = text;
      render();
    }
    if (text) live.replaceChildren(text.slice(0, shown), h('span', { class: 'unsaid' }, text.slice(shown)));
    const log = live.parentElement;
    if (log) log.scrollTop = log.scrollHeight;
  };
  function addLine(l: Line) {
    if (l.who === 'agent' && l.text === liveText) liveText = null;
    s.lines = [...s.lines, { ...l, at: l.at ?? Date.now() }].sort((x, y) => (x.at ?? 0) - (y.at ?? 0)).slice(-30);
    render();
  }
  const operator = new Operator(api, presence, page, {
    // In the order things were said: a line it said while you typed comes before what you typed. The line it just
    // finished saying takes the place of the live one.
    line: (l) => addLine(l),
    busy: (label) => ((s.busy = label), render()),
    changed: () => void loadChanges(),
  });
  const coach = new Coach(api, operator, render);

  const loadChanges = () =>
    api
      .changes()
      .then((r) => ((s.changes = r.changes), render()))
      .catch(() => {});
  const loadPolicy = () =>
    api
      .policy()
      .then((p) => ((s.policy = p), render()))
      .catch(() => {});

  const versionOf = (id: string | null | undefined) => s.policy?.versions.find((v) => v.id === id) ?? null;
  const champion = () => versionOf(s.policy?.champion);

  /** What it's going on (failures land in the panel, not the console). */
  async function attempt(work: () => Promise<unknown>, fallback: Stage) {
    s.error = null;
    try {
      await work();
    } catch (err) {
      s.error = (err as Error).message;
      s.stage = fallback;
    }
    render();
  }

  // ---- asking and telling ----

  /** What you type (or say) stays in the box across renders. */
  const ask = h('input', { class: 'ask-input', type: 'text', 'aria-label': 'Ask your agent', autocomplete: 'off' }) as HTMLInputElement;

  /**
   * Asks it for something, or (while it works) tells it something it acts on in its next step. While you teach it,
   * what you type is you explaining (a note in the lesson), not a request: it's watching you work, not working.
   */
  function say(text: string) {
    text = text.trim();
    if (!text) return;
    presence.wake();
    s.lines = [...s.lines, { who: 'you' as const, text, at: Date.now() }].slice(-30);
    if (coach.recording && !operator.running) {
      coach.note(text);
      return render();
    }
    if (coach.recording) coach.ask(text);
    if (operator.running) operator.hear(text);
    else void operator.run(text).then(() => (render(), loadPolicy()));
    render();
  }
  const send = () => {
    const text = ask.value;
    ask.value = '';
    say(text);
  };
  ask.addEventListener('keydown', (e) => e.key === 'Enter' && send());

  // Talking to it in Chat: each finished phrase is said to it (while coaching, the coach's microphone takes over).
  let chatMic: Listening | null = null;
  function toggleChatMic() {
    if (chatMic) {
      chatMic.stop();
      chatMic = null;
      s.hearing = '';
      return render();
    }
    presence.wake();
    chatMic = listen(
      {
        interim: (t) => ((s.hearing = t), render()),
        final: (t) => ((s.hearing = ''), say(t)),
        error: (m) => ((s.error = m), (chatMic = null), render()),
        ended: () => ((chatMic = null), (s.hearing = ''), render()),
      },
      true,
    );
    render();
  }

  // The coaching clock ticks in place (a full render would take focus from what you're typing).
  const timer = h('span', { class: 'rec-time' });
  setInterval(() => coach.recording && (timer.textContent = clock(coach.elapsed())), 500);

  function askRow(placeholder: string) {
    const working = operator.running;
    const explaining = coach.recording && !working;
    ask.placeholder = working ? 'Tell it something…' : explaining ? 'Explain what you’re doing…' : placeholder;
    const listening = !!chatMic;
    return h(
      'div',
      { class: 'ask' },
      ask,
      canListen() && !coach.recording && h('button', { class: `icon-btn${listening ? ' on' : ''}`, type: 'button', 'aria-label': listening ? 'Stop listening' : 'Talk to it', 'aria-pressed': String(listening), onClick: toggleChatMic, html: icon('mic', 16) }),
      working || explaining ? h('button', { class: 'btn', type: 'button', onClick: send }, explaining ? 'Note' : 'Tell') : h('button', { class: 'btn primary', type: 'button', onClick: send }, 'Ask'),
      working && h('button', { class: 'btn', type: 'button', onClick: () => operator.stop() }, 'Stop'),
    );
  }

  // ---- the tabs ----

  function chatTab() {
    return [
      s.lines.length || liveText ? h('ol', { class: 'log' }, ...s.lines.map((l) => h('li', { class: `line ${l.who}` }, l.text)), liveText ? live : null) : h('p', { class: 'sub hint' }, 'It sees what you see and uses the same controls you do. Ask it for something and watch it work; tell it if it’s going wrong.'),
      askRow('Ask your agent to…'),
      s.hearing && h('p', { class: 'hearing' }, s.hearing),
      h('p', { class: 'status', role: 'status' }, s.busy ? h('span', {}, h('span', { class: 'spin', html: icon('loading', 14) }), ' ', s.busy) : ''),
      measured(),
      s.changes.length > 0 &&
        h(
          'div',
          { class: 'changes' },
          h('p', { class: 'eyebrow' }, 'Its changes to this app'),
          h('ul', { class: 'change-list' }, ...s.changes.map((c) => h('li', {}, h('strong', {}, c.title), h('span', { class: 'meta' }, c.why)))),
          h('button', { class: 'btn', type: 'button', disabled: operator.running, onClick: () => void api.undoChange().then(() => location.reload()) }, iconEl('undo', 16), 'Undo the last change'),
        ),
    ];
  }

  /**
   * What its last request measurably was (facts.ts), all its steps together: what the orb is moved by (tokens, its
   * tools, the loop), and what it did on the page (vision, touch). Every number is measured; the estimates say so.
   */
  function measured() {
    const steps = operator.ledger.request;
    if (!steps.length) return null;
    const m = measure(steps);
    const k = (n: number) => (n >= 9950 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
    const sec = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
    const row = (name: string, text: string) => h('div', {}, h('dt', {}, name), h('dd', {}, text));
    const d = h(
      'details',
      { class: 'measured', ...(s.measured ? { open: true } : {}) },
      h('summary', {}, `Measured · ${operator.running ? 'so far' : 'its last request'}: ${m.steps} step${m.steps > 1 ? 's' : ''}, ${sec(m.span_ms)}`),
      h(
        'dl',
        {},
        row('Tokens', `read ${k(m.tokens.read)} (${k(m.tokens.cached)} cached), wrote ${k(m.tokens.wrote)} in ${sec(m.tokens.thinking_ms)}: ${Math.round(m.tokens.writeRate)} tok/s end to end`),
        row('Vision', m.vision.pictures ? `${m.vision.pictures} picture${m.vision.pictures > 1 ? 's' : ''}, ${k(m.vision.tokens)} tokens est. (${Math.round(100 * m.vision.share)}% of what it read new)${m.vision.zoom > 1.05 ? `, ${m.vision.zoom.toFixed(1)}× closer` : ''}` : 'read the page (no pictures)'),
        row('Touch', m.touch.moves ? `${m.touch.moves} control${m.touch.moves > 1 ? 's' : ''}, ${m.touch.travel.toFixed(2)} of a range in ${sec(m.touch.handsOn_ms)}` : 'nothing moved'),
        row('Tools', m.tools.calls ? `${m.tools.calls} call${m.tools.calls > 1 ? 's' : ''}, ${sec(m.tools.mean_ms)} each` : 'none'),
        row('The loop', `looked ${sec(m.loop.looking_ms)}, thought ${sec(m.loop.thinking_ms)}, acted ${sec(m.loop.acting_ms)}`),
      ),
    );
    d.addEventListener('toggle', () => (s.measured = (d as HTMLDetailsElement).open));
    return d;
  }

  function practicing() {
    const p = s.progress;
    const noun = site.practice?.noun ?? 'example';
    return [
      h('h3', {}, 'Practicing'),
      h('p', { class: 'status' }, h('span', { class: 'spin', html: icon('loading', 14) }), p ? (p.version === 'judge' ? ' Comparing the edits with what you taught it…' : ` ${noun[0]!.toUpperCase()}${noun.slice(1)} ${p.photo} of ${p.of}: ${p.version} is working on it`) : ' Getting ready…'),
      p && h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: `width:${(100 * (p.version === 'judge' ? 1 : (p.photo - 1) / p.of)).toFixed(0)}%` })),
      h('p', { class: 'meta' }, `It opens each ${noun} in the app and works on it, once per version, then puts back what you had open. Leave the app to it until it’s done.`),
    ];
  }

  function practiceResults(p: Practice) {
    const a = versionOf(p.a)!;
    const b = versionOf(p.b)!;
    const wins = { a: p.episodes.filter((e) => e.winner === 'a').length, b: p.episodes.filter((e) => e.winner === 'b').length };
    // Even photos count: "won 1 of 3" alone reads like it lost the other two.
    const even = p.episodes.length - wins.a - wins.b;
    const tail = even ? `, ${even} even` : '';
    const lead = wins.b > wins.a ? `v${b.n} won ${wins.b} of ${p.episodes.length}${tail}` : wins.a > wins.b ? `v${a.n} won ${wins.a} of ${p.episodes.length}${tail}` : `Even on all ${p.episodes.length}`;
    const thumb = (name: string, label: string, won: boolean, settings?: string) =>
      h('figure', { class: `thumb${won ? ' won' : ''}` }, h('a', { href: api.imageUrl(name), target: '_blank', rel: 'noopener', title: 'Open it full size' }, h('img', { src: api.imageUrl(name), alt: label })), h('figcaption', {}, label, won ? ' ✓' : ''), settings && h('p', { class: 'settings' }, ...settings.split(' · ').map((x) => h('span', {}, x))));
    return [
      h('h3', {}, lead),
      h('p', { class: 'sub lead' }, 'Judged against what you taught it, not general taste. You decide which version it follows.'),
      h(
        'ol',
        { class: 'episodes' },
        ...p.episodes.map((e) =>
          h('li', {}, h('div', { class: 'thumbs' }, thumb(e.original, 'Original', false), thumb(e.a, `v${a.n}`, e.winner === 'a', e.settings?.a), thumb(e.b, `v${b.n}`, e.winner === 'b', e.settings?.b)), h('p', { class: 'why' }, e.winner === 'tie' ? `Even. ${e.why}` : e.why)),
        ),
      ),
      p.kept
        ? h('p', { class: 'meta' }, `It follows v${versionOf(p.kept)?.n} now.`)
        : h(
            'div',
            { class: 'actions footer' },
            // The one that did better first (the new one when it's even).
            ...(wins.a > wins.b ? [a, b] : [b, a]).map((v, i) => h('button', { class: `btn${i === 0 ? ' primary' : ''}`, type: 'button', onClick: () => void attempt(async () => ((s.practice = await api.keep(p.id, v.id)), await loadPolicy()), 'results') }, `Keep v${v.n}`)),
            h('button', { class: 'btn ghost', type: 'button', onClick: () => ((s.stage = 'idle'), (s.practice = null), render()) }, 'Not now'),
          ),
      p.kept && h('div', { class: 'actions' }, h('button', { class: 'btn ghost', type: 'button', onClick: () => ((s.stage = 'idle'), (s.viewing = p.kept!), render()) }, 'See its policy')),
    ];
  }

  function rulesList(v: PolicyVersion) {
    if (!v.rules.length) return h('p', { class: 'meta' }, 'Nothing taught yet: it uses its own judgment. Press the cap by your agent to teach it.');
    return h(
      'div',
      { class: 'rules' },
      ...LAYERS.filter((l) => v.rules.some((r) => r.layer === l)).map((l) => h('div', { class: 'rule-group' }, h('p', { class: 'layer' }, l), h('ul', {}, ...v.rules.filter((r) => r.layer === l).map((r) => h('li', {}, r.text))))),
    );
  }

  /** A version's practice, each one reopenable. */
  function practiceLinks(v: PolicyVersion, p: PolicyState) {
    const games = p.practices.filter((g) => g.a === v.id || g.b === v.id);
    if (!games.length) return null;
    return h(
      'div',
      { class: 'detail' },
      h('p', { class: 'eyebrow' }, 'Practice'),
      h(
        'ul',
        { class: 'practice-list' },
        ...games.reverse().map((g) => {
          const side = g.a === v.id ? 'a' : 'b';
          const other = versionOf(side === 'a' ? g.b : g.a);
          const won = g.episodes.filter((e) => e.winner === side).length;
          const even = g.episodes.filter((e) => e.winner === 'tie').length;
          return h('li', {}, h('button', { class: 'link', type: 'button', onClick: () => ((s.practice = g), (s.stage = 'results'), render()) }, `Against v${other?.n}: won ${won} of ${g.episodes.length}${even ? `, ${even} even` : ''}`), h('span', { class: 'meta' }, new Date(g.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })));
        }),
      ),
    );
  }

  /** Where a version came from: the lesson it learned, with its recording to watch. */
  function lessonOf(v: PolicyVersion) {
    const lesson = s.policy?.sessions.find((x) => x.id === v.session);
    if (!lesson) return null;
    const when = new Date(lesson.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return h(
      'div',
      { class: 'detail lesson' },
      h('p', { class: 'eyebrow' }, `Learned from your lesson · ${when}`),
      lesson.analysis?.summary && h('p', { class: 'sub lead clamp', title: 'Show all', onClick: (e: Event) => (e.currentTarget as HTMLElement).classList.toggle('clamp') }, lesson.analysis.summary),
      lesson.recording && h('a', { class: 'link', href: api.recordingUrl(lesson.id), target: '_blank', rel: 'noopener' }, 'Watch the lesson'),
    );
  }

  function policyTab() {
    if (s.stage === 'practicing') return practicing();
    if (s.stage === 'results' && s.practice) return practiceResults(s.practice);
    const p = s.policy;
    if (!p) return [h('p', { class: 'meta' }, 'Loading…')];
    const viewing = versionOf(s.viewing) ?? champion();
    const versions = [...p.versions].sort((x, y) => y.n - x.n);
    const record = (v: PolicyVersion) => {
      const games = p.practices.filter((x) => x.a === v.id || x.b === v.id);
      const won = games.reduce((n, g) => n + g.episodes.filter((e) => e.winner === (g.a === v.id ? 'a' : 'b')).length, 0);
      const of = games.reduce((n, g) => n + g.episodes.length, 0);
      return of ? `won ${won} of ${of} in practice` : v.session ? 'not practiced' : 'the base';
    };
    return [
      h(
        'div',
        { class: 'rows' },
        ...versions.map((v) =>
          h(
            'button',
            { class: 'row', type: 'button', 'aria-current': String(viewing?.id === v.id), onClick: () => ((s.viewing = v.id), render()) },
            h('span', { class: 'radio', 'aria-hidden': 'true' }),
            h('span', { class: 'row-name' }, `v${v.n}`, h('span', { class: 'row-by' }, `${plural(v.rules.length, 'rule')} · ${record(v)}`)),
            v.id === p.champion ? h('span', { class: 'best' }, 'in use') : h('span'),
          ),
        ),
      ),
      viewing && h('div', { class: 'detail' }, h('strong', {}, `Policy v${viewing.n}`), rulesList(viewing)),
      viewing && lessonOf(viewing),
      viewing && practiceLinks(viewing, p),
      viewing &&
        viewing.id === p.champion &&
        site.practice &&
        versionOf(viewing.parent) &&
        h('div', { class: 'actions footer' }, h('button', { class: 'btn', type: 'button', disabled: operator.running, onClick: () => void runPractice(versionOf(viewing.parent)!, viewing) }, `Practice v${viewing.n} against v${versionOf(viewing.parent)!.n}`)),
      viewing &&
        viewing.id !== p.champion &&
        h(
          'div',
          { class: 'actions footer' },
          site.practice && champion() && h('button', { class: 'btn primary', type: 'button', disabled: operator.running, onClick: () => void runPractice(champion()!, viewing) }, `Practice v${viewing.n} against v${champion()!.n}`),
          h('button', { class: 'btn', type: 'button', onClick: () => void attempt(async () => (await api.setChampion(viewing.id), await loadPolicy()), 'idle') }, `Use v${viewing.n}`),
        ),
    ];
  }

  // ---- the flow ----

  // ---- teaching: the grad cap ----

  let teach: Teach = 'off';
  let eyes = 0;

  /** Its eyes follow what you're doing while you teach it: each control you change, for a moment. */
  const watchYou = (el: HTMLElement) => {
    presence.see(boxOf(el));
    clearTimeout(eyes);
    eyes = window.setTimeout(() => !operator.running && presence.see(null), 1600);
  };

  /** The cap: starts a lesson, or ends one (and trains on it). */
  async function toggleTeaching() {
    if (teach === 'off') return startTeaching();
    if (teach === 'on') return endTeaching();
  }

  async function startTeaching() {
    teach = 'starting';
    s.error = null;
    presence.wake();
    render();
    try {
      await coach.start({ onMove: watchYou, onEnded: () => void endTeaching() });
      teach = 'on';
    } catch (err) {
      teach = 'off';
      s.error = `Couldn't start the lesson: ${(err as Error).message}`;
    }
    render();
  }

  /** Ends the lesson and trains on it: a new version from all it learned, which the agent follows from now on. */
  async function endTeaching() {
    if (teach !== 'on') return;
    teach = 'training';
    clearTimeout(eyes);
    presence.see(null);
    presence.state('thinking');
    render();
    try {
      const recording = await coach.stop();
      const lesson = coach.session!;
      if (recording) void api.uploadRecording(lesson.id, recording).then(() => loadPolicy());
      const { session, version } = await api.train(lesson.id);
      coach.session = null;
      await loadPolicy();
      const learned = version ? session.analysis?.proposals.length ?? 0 : 0;
      const gist = session.analysis?.summary.split(/(?<=\.)\s/)[0] ?? '';
      const line = version ? `I learned ${plural(learned, 'thing')} from that. ${gist} I'm following policy v${version.n} now.` : "I didn't pick up anything new from that one.";
      s.viewing = version?.id ?? s.viewing;
      presence.state('idle');
      void presence.say(line).then(() => (addLine({ who: 'agent', text: line }), presence.clear(9000)));
    } catch (err) {
      s.error = `The lesson didn't train: ${(err as Error).message}`;
      presence.state('idle');
    }
    teach = 'off';
    render();
  }

  async function runPractice(a: PolicyVersion, b: PolicyVersion) {
    s.stage = 'practicing';
    s.progress = null;
    render();
    s.tab = 'policy';
    await attempt(async () => {
      s.practice = await practice(api, operator, site, a, b, (p) => ((s.progress = p), render()));
      s.stage = 'results';
    }, 'idle');
    void loadPolicy();
  }

  function panel(onClose: () => void): HTMLElement {
    const v = champion();
    const tab = (id: Tab, label: string) => h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(s.tab === id), onClick: () => ((s.tab = id), id === 'policy' && void loadPolicy(), render()) }, label);
    return h(
      'section',
      { class: `panel agent-panel tab-${s.tab}`, 'aria-label': 'Your agent' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h2', {}, 'Your agent'), h('p', { class: 'sub' }, `${site.name}${v ? ` · policy v${v.n}` : ''}${teach === 'on' ? ' · learning from you' : teach === 'training' ? ' · training' : ''}`)),
        h(
          'div',
          { class: 'head-actions' },
          h('button', { class: 'close', type: 'button', 'aria-label': s.muted ? 'Unmute its voice' : 'Mute its voice', 'aria-pressed': String(s.muted), onClick: () => ((s.muted = !s.muted), localStorage.setItem(MUTED_KEY, s.muted ? '1' : '0'), presence.setMuted(s.muted), render()), html: icon(s.muted ? 'muted' : 'voice', 16) }),
          h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onClick: onClose, html: icon('close', 16) }),
        ),
      ),
      h('div', { class: 'tabs', role: 'tablist' }, tab('chat', 'Chat'), tab('policy', 'Policy')),
      ...(s.tab === 'chat' ? chatTab() : policyTab()),
      s.error && h('p', { class: 'status error', role: 'alert' }, s.error),
    );
  }

  return {
    presence,
    operator,
    coach,
    panel,
    get working() {
      return operator.running;
    },
    focus: () => (s.tab === 'chat' ? ask : null)?.focus(),
    /** Shows a tab (the overlay opens your agent on its policy). */
    showTab(tab: Tab) {
      s.tab = tab;
      if (tab === 'policy') void loadPolicy();
      render();
    },
    /** The grad cap: where teaching is, and pressing it. */
    get teach() {
      return teach;
    },
    toggleTeaching,
    /** On load: its changes and policy, and a request it was in the middle of when it changed the app's code. */
    async start(open: () => void) {
      void loadChanges();
      void loadPolicy();
      // It's here: it wakes (its presence, from asleep).
      operator.ledger.setPresence('waking');
      const resume = operator.takeResume();
      if (resume) {
        s.lines = [{ who: 'you', text: resume.request }];
        open();
        void operator.run(resume.request, resume).then(render);
      }
    },
  };
}
