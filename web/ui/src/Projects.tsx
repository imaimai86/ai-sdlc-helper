// The registered projects (and the folder ui started in), their doctor checks, and adding one.
import { useEffect, useState } from 'preact/hooks';
import { api, type Check, type Project } from './api';
import { Cli, ErrorBox, useApp } from './ui';

function Doctor({ name }: { name: string }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState('');
  const run = () => { setChecks(null); setError(''); api.doctor(name).then(r => setChecks(r.checks)).catch(e => setError((e as Error).message)); };
  useEffect(run, [name]);
  if (error) return <ErrorBox error={error} />;
  if (!checks) return <p class="small muted">Checking…</p>;
  const failed = checks.filter(c => !c.ok && c.required).length;
  return (
    <div class="col" style={{ gap: '0' }}>
      <span class={`small ${failed ? 's-failed' : 's-done'}`} style={{ paddingBottom: '6px' }}>{failed ? `✘ ${failed} required check${failed > 1 ? 's' : ''} failing` : '✔ ready'}</span>
      {checks.map(c => (
        <div style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr)', gap: '2px 8px', padding: '7px 0', borderTop: '1px solid var(--ln)', fontSize: '13px' }}>
          <span class={c.ok ? 's-done' : c.required ? 's-failed' : 's-paused'}>{c.ok ? '✔' : c.required ? '✘' : '!'}</span>
          <span><strong>{c.name}</strong> · {c.detail}{!c.ok && c.fix && <><br /><span class="muted">Fix: {c.fix}</span></>}</span>
        </div>
      ))}
      <div class="row" style={{ paddingTop: '10px' }}><button class="btn btn-s" type="button" onClick={run}>Run doctor again</button></div>
    </div>
  );
}

export function Projects({ projects, reload }: { projects: Project[]; reload(): void }) {
  const { project, go, toast } = useApp();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [out, setOut] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (dir: string, n?: string) => {
    setBusy(true); setError(''); setOut('');
    try {
      const r = await api.addProject(dir, n || undefined);
      setOut([...r.out, ...r.err].join('\n'));
      if (r.ok) { toast(`Registered ${dir}`); reload(); }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div class="col">
      <div class="row"><h1 class="grow">Projects</h1><span class="mono small muted">~/.config/ai-sdlc-helper/projects.json</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
        {projects.map(p => (
          <section class="pn" style={p.name === project ? { borderColor: 'var(--pri)' } : {}}>
            <div class="ph">
              <h2 class="mono">{p.name} {p.name === project && <span class="tag">current</span>} {!p.registered && <span class="tag s-paused">not registered</span>}</h2>
              <div class="row">
                {p.name !== project && <button class="btn btn-s" type="button" onClick={() => go(`/board?project=${encodeURIComponent(p.name)}`)}>Open</button>}
                {!p.registered && <button class="btn btn-s btn-p" type="button" disabled={busy} onClick={() => add(p.path)}>Register</button>}
              </div>
            </div>
            <div class="pb col" style={{ gap: '8px' }}>
              <span class="mono small muted" style={{ overflowWrap: 'anywhere' }}>{p.path}</span>
              <Doctor name={p.name} />
            </div>
          </section>
        ))}
        <section class="pn" style={{ borderStyle: 'dashed' }}>
          <div class="ph"><h2>Add a project</h2></div>
          <form class="pb col" style={{ gap: '8px' }} onSubmit={e => { e.preventDefault(); add(path, name); }}>
            <label class="lbl" for="pp">Folder (any path inside a git repository)</label>
            <input id="pp" class="inp mono" value={path} placeholder="/home/me/code/storefront" onInput={e => setPath((e.target as HTMLInputElement).value)} />
            <label class="lbl" for="pnm">Name (optional)</label>
            <input id="pnm" class="inp mono" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} />
            <p class="small muted" style={{ margin: 0 }}>Registers it and writes sdlc.config.json and a backlog index when they are missing, as <span class="mono">add --yes</span> does.</p>
            <div class="row"><button class="btn btn-p" type="submit" disabled={busy || !path.trim()}>{busy ? 'Adding…' : 'Add project'}</button></div>
            <Cli args={['add', path || '<folder>', '--yes', ...(name ? ['--name', name] : [])]} />
            <ErrorBox error={error} />
            {out && <pre class="code mono" style={{ borderRadius: '6px' }}>{out}</pre>}
          </form>
        </section>
      </div>
    </div>
  );
}
