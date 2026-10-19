// A new backlog item: slug, type, title and the brief (the triage skill's sections as a template), with a preview.
import { useState } from 'preact/hooks';
import { api } from './api';
import { ErrorBox, Future, Markdown, useApp } from './ui';

const template = (slug: string, type: string, priority: string) => `# ${slug || '<slug>'}

Type: ${type}
Priority: ${priority}

## Problem


## Expected behaviour


## Decisions
-

## Scope
- In:
- Out:

## Tests
-

## Docs
-

## Open questions
- none
`;

const PRIORITIES = ['P1 (high)', 'P2 (normal)', 'P3 (low)'];

export function NewItem({ taken }: { taken: string[] }) {
  const { project, go, toast } = useApp();
  const [slug, setSlug] = useState('');
  const [type, setType] = useState('feature');
  const [priority, setPriority] = useState('P2 (normal)');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState(() => template('', 'feature', 'P2 (normal)'));
  const [view, setView] = useState<'write' | 'split' | 'preview'>('split');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const slugOk = /^[a-z0-9][a-z0-9-]*$/.test(slug);
  const slugFree = !taken.includes(slug);
  const empty = ['## Problem', '## Expected behaviour'].filter(h => { const m = brief.split(h)[1]; return m !== undefined && !m.split('\n## ')[0].trim(); });

  const save = async (start: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await api.addItem(project, { slug, type, title, brief: brief.replace(/^# <slug>/, `# ${slug}`), start });
      if (r.started && !r.started.ok) toast(`Saved ${slug}; start refused: ${r.started.err.join(' ')}`);
      else toast(start ? `Saved and started ${slug}` : `Saved ${slug}`);
      go(start ? `/run/${slug}` : '/board');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div class="col">
      <div class="row">
        <h1 class="grow">New backlog item</h1>
        <button class="btn" type="button" disabled title="Waits on engine request E-8">Draft with the triage agent <Future id="E-8" /></button>
        <button class="btn" type="button" disabled title="Waits on engine request E-14">Import from issue URL <Future id="E-14" /></button>
      </div>
      <section class="pn">
        <div class="pb" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
          <div class="col" style={{ gap: '6px' }}>
            <label class="lbl" for="slug">Slug</label>
            <input id="slug" class="inp mono" value={slug} placeholder="add-rate-limit" onInput={e => setSlug((e.target as HTMLInputElement).value.trim())} />
            <span class={`small ${slug && (!slugOk || !slugFree) ? 's-failed' : 'muted'}`}>{!slug ? 'lowercase letters, digits and dashes' : !slugOk ? 'only lowercase letters, digits and dashes' : !slugFree ? 'already in the backlog' : '✔ free'}</span>
          </div>
          <div class="col" style={{ gap: '6px' }}>
            <label class="lbl" for="type">Type</label>
            <select id="type" class="inp" value={type} onChange={e => setType((e.target as HTMLSelectElement).value)}><option>feature</option><option>bug</option></select>
          </div>
          <div class="col" style={{ gap: '6px' }}>
            <label class="lbl" for="prio">Priority</label>
            <select id="prio" class="inp" value={priority} onChange={e => setPriority((e.target as HTMLSelectElement).value)}>{PRIORITIES.map(p => <option>{p}</option>)}</select>
          </div>
          <div class="col" style={{ gap: '6px', gridColumn: '1 / -1' }}>
            <label class="lbl" for="title">Title (the index line)</label>
            <input id="title" class="inp" value={title} onInput={e => setTitle((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="mono small muted" style={{ padding: '0 14px 12px' }}>index.md ← - [ ] `{slug || '<slug>'}` - {type === 'bug' ? 'Bug' : 'Feature'}: {title || '<title>'}</div>
      </section>
      <section class="pn">
        <div class="ph">
          <h2 class="mono">brief.md</h2>
          <div class="segs" role="tablist" aria-label="Editor view">
            {(['write', 'split', 'preview'] as const).map(m => <button class={`seg ${view === m ? 'seg-on' : ''}`} type="button" role="tab" aria-selected={view === m} onClick={() => setView(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
          </div>
          <button class="btn btn-s" type="button" onClick={() => setBrief(template(slug, type, priority))}>Insert template</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {view !== 'preview' && (
            <>
              <label class="sr" for="brief">Brief, Markdown</label>
              <textarea id="brief" class="mono" value={brief} onInput={e => setBrief((e.target as HTMLTextAreaElement).value)}
                style={{ flex: '1 1 420px', minWidth: 0, minHeight: '480px', border: 0, borderRight: '1px solid var(--ln)', background: 'var(--code)', color: 'var(--tx)', padding: '14px', fontSize: '12.5px', lineHeight: 1.7, resize: 'vertical' }} />
            </>
          )}
          {view !== 'write' && (
            <div style={{ flex: '1 1 420px', minWidth: 0, padding: '14px 18px' }}>
              <Markdown text={brief} />
              <div class="small muted" style={{ border: '1px solid var(--ln)', borderRadius: '6px', padding: '10px 12px', marginTop: '10px' }}>
                {empty.length ? `Still empty: ${empty.map(h => h.slice(3)).join(', ')}. ` : 'Every main section has text. '}
                The fewer gaps here, the fewer Spec question rounds.
              </div>
            </div>
          )}
        </div>
      </section>
      <ErrorBox error={error} />
      <div class="row">
        <button class="btn btn-p" type="button" disabled={busy || !slugOk || !slugFree || !title.trim()} onClick={() => save(true)}>Save and start</button>
        <button class="btn" type="button" disabled={busy || !slugOk || !slugFree || !title.trim()} onClick={() => save(false)}>Save</button>
        <a class="btn" href="#/board" onClick={e => { e.preventDefault(); go('/board'); }}>Cancel</a>
        <span class="mono small muted" style={{ marginLeft: 'auto' }}>writes in the main working tree · not committed</span>
      </div>
    </div>
  );
}
