import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { QUOTA_LOW_PERCENT, QUOTA_RESET_NOTICE_MINUTES } from '../../../src/quota/reminders.js';
import type { ApiInfo, Config, SettingsInfo, TargetQuota, WorkspaceInfo } from '../shared/api.js';
import { unify } from './api.js';
import { Icon, Spinner, Switch, ago, hue, until } from './ui.js';

type Notify = (msg: string, kind?: 'ok' | 'err') => void;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── welcome ───────────────────────────────────────────────────────────────
export function Welcome({ onOpen }: { onOpen(dir?: string): void }) {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => { void unify.recentWorkspaces().then(setRecent); }, []);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="logo"><Icon name="spark" size={22} /></div>
        <h1>Unify</h1>
        <p className="lede">把同一个问题发给多个模型，并排比较回答，匿名汇总，再选一个方案实施。</p>
        <button className="btn primary big" onClick={() => onOpen()}><Icon name="folder" />打开项目文件夹</button>
        {recent.length > 0 && (
          <div className="recent">
            <div className="label">最近打开</div>
            {recent.map((p) => (
              <button key={p} className="recent-item" onClick={() => onOpen(p)}>
                <b>{p.split(/[\\/]/).filter(Boolean).pop()}</b><span>{p}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── quota ─────────────────────────────────────────────────────────────────
export function QuotaPage({ quota, loading, refresh }: { quota?: TargetQuota[]; loading: boolean; refresh(): void }) {
  const groups = new Map<string, TargetQuota[]>();
  for (const q of quota ?? []) groups.set(q.provider, [...(groups.get(q.provider) ?? []), q]);
  const checked = quota?.[0]?.checkedAt;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>套餐额度</h1>
          <p className="lede">每分钟检查。额度重置前 {QUOTA_RESET_NOTICE_MINUTES} 分钟仍有剩余，或余量降至 {QUOTA_LOW_PERCENT}% 时提醒。</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>{loading ? <Spinner /> : <Icon name="retry" />}刷新</button>
      </header>
      {checked && <div className="page-meta">更新于 {new Date(checked).toLocaleTimeString('zh-CN')}</div>}
      {!quota ? <div className="pending"><Spinner />正在查询…</div> : (
        <div className="quota-grid">
          {[...groups.entries()].map(([provider, rows]) => {
            const { reading } = rows[0];
            return (
              <section key={provider} className="quota-card" style={{ '--h': hue(rows[0].targetId) } as CSSProperties}>
                <header>
                  <i className="dot" />
                  <b>{rows.map((r) => r.label).join('、')}</b>
                  <span className="faint">{provider}</span>
                </header>
                {reading.status !== 'ok' ? (
                  <p className={`quota-msg ${reading.status}`}>{reading.status === 'error' ? '查询失败 · ' : ''}{reading.message}</p>
                ) : reading.limits.length === 0 ? <p className="quota-msg">没有返回额度项</p> : (
                  <ul className="limits">
                    {reading.limits.map((l, i) => {
                      const ratio = l.unit === '%' ? l.remaining / 100 : l.total ? l.remaining / l.total : undefined;
                      return (
                        <li key={i}>
                          <div className="limit-row">
                            <span>{l.label}</span>
                            <b>{l.remaining}{l.total !== undefined ? <span className="faint"> / {l.total}</span> : null}{l.unit === '%' ? '%' : ` ${l.unit}`}</b>
                          </div>
                          {ratio !== undefined && (
                            <div className={`meter${ratio < 0.15 ? ' low' : ratio < 0.4 ? ' mid' : ''}`}><i style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} /></div>
                          )}
                          {l.resetsAt && <div className="faint small">{until(l.resetsAt)}</div>}
                        </li>
                      );
                    })}
                    {reading.observedAt && <li className="faint small">数据时间 {ago(reading.observedAt)}</li>}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── memory ────────────────────────────────────────────────────────────────
export function MemoryPage({ cwd, notify }: { cwd: string; notify: Notify }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    unify.memoryUrl().then(setUrl, (err) => notify(errText(err), 'err'));
  }, [cwd, notify]);
  if (!url) return <div className="page"><div className="pending"><Spinner />正在扫描记忆…</div></div>;
  return <iframe className="memory-frame" src={url} title="记忆管理" />;
}

// ── settings ──────────────────────────────────────────────────────────────
function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      <h2>{title}</h2>
      {note && <p className="set-note">{note}</p>}
      <div className="set-rows">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label"><div>{label}</div>{hint && <small>{hint}</small>}</div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function NumberField({ value, fallback, onSave }: { value?: number; fallback: number; onSave(v?: number): void }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const next = draft.trim() === '' ? undefined : Number(draft);
    if (next !== value) onSave(next);
  };
  return <input className="num" inputMode="numeric" value={draft} placeholder={String(fallback)} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}

function JsonField({ value, onSave }: { value: unknown; onSave(v: unknown): void }) {
  const initial = value === undefined ? '' : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  useEffect(() => setDraft(initial), [initial]);
  return (
    <div className="json-field">
      <textarea value={draft} spellCheck={false} rows={Math.min(14, Math.max(3, draft.split('\n').length))} placeholder="{}" onChange={(e) => { setDraft(e.target.value); setError(''); }} />
      <div className="json-acts">
        {error && <span className="err-text">{error}</span>}
        <button className="btn" disabled={draft === initial} onClick={() => {
          try { onSave(draft.trim() ? JSON.parse(draft) : undefined); }
          catch { setError('不是有效的 JSON'); }
        }}>保存</button>
      </div>
    </div>
  );
}

function ApiRow({ api, onSaved, notify }: { api: ApiInfo; onSaved(ws: WorkspaceInfo): void; notify: Notify }) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(api.model);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setModel(api.model), [api.model]);
  const status = api.blocked ? api.blocked : api.configured ? `已接入 · ${api.model}${api.hasKey ? '' : ` · 使用 ${api.apiKeyEnv}`}` : api.envKey ? `可用 · 环境变量 ${api.apiKeyEnv}` : '未接入';
  return (
    <div className={`api-row${open ? ' open' : ''}`}>
      <div className="set-row">
        <div className="set-label"><div>{api.label}</div><small className={api.configured || api.envKey ? 'ok-text' : ''}>{status}</small></div>
        <div className="set-control"><button className="btn" disabled={!!api.blocked} onClick={() => setOpen(!open)}>{open ? '收起' : api.configured ? '修改' : '接入'}</button></div>
      </div>
      {open && (
        <form className="api-form" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onSaved(await unify.saveApi(api.id, model, key.trim() || undefined));
            setKey('');
            setOpen(false);
            notify(`已接入 ${api.label} · ${model}`, 'ok');
          } catch (err) { notify(errText(err), 'err'); }
          setBusy(false);
        }}>
          <label>模型
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {api.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label>API Key
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder={api.hasKey ? '留空沿用已保存的密钥' : api.envKey ? `留空使用 ${api.apiKeyEnv}` : '粘贴密钥'} />
          </label>
          <p className="set-note">密钥以明文保存在 ~/.unify/api/{api.id}.json（POSIX 权限 0600）。{api.baseUrl}</p>
          <div className="json-acts"><button className="btn primary" disabled={busy || !model}>保存</button></div>
        </form>
      )}
    </div>
  );
}

export function SettingsPage({ ws, onChange, notify }: { ws: WorkspaceInfo; onChange(ws: WorkspaceInfo): void; notify: Notify }) {
  const [info, setInfo] = useState<SettingsInfo>();
  const load = () => unify.settings().then(setInfo, (err) => notify(errText(err), 'err'));
  useEffect(() => { void load(); }, [ws]);

  const save = async (key: keyof Config, value: unknown, entry?: string) => {
    try {
      onChange(await unify.setSetting(key, value, entry));
      notify('已保存', 'ok');
    } catch (err) { notify(errText(err), 'err'); }
  };
  if (!info) return <div className="page"><div className="pending"><Spinner />读取设置…</div></div>;
  const cfg = info.merged;
  const providers = cfg.providers;
  const label = (id: string) => ws.targets.find((t) => t.id === id)?.label ?? id;

  return (
    <div className="page settings">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p className="lede">常用设置写入当前项目的 unify.config.json，从下一次提问生效。API 凭证、自定义端点和额度命令保存在用户目录。</p>
        </div>
      </header>
      {ws.configError && <div className="error block"><Icon name="alert" size={14} /><span>{ws.configError}</span></div>}

      <Section title="官方 API" note="接入后即可直接提问，不需要安装模型 CLI。">
        {info.apis.map((api) => <ApiRow key={api.id} api={api} notify={notify} onSaved={(next) => { onChange(next); void load(); }} />)}
      </Section>

      <Section title="模型与思考强度" note="「默认」让底层服务或 CLI 决定思考强度。测试会按已保存的配置发送一次简短提问。">
        {ws.targets.map((t) => (
          <div key={t.id} className="model-setting">
            <Row label={<span className="target-label" style={{ '--h': hue(t.id) } as CSSProperties}><i className="dot" />{t.label}<code>{t.id}</code></span>}
              hint={t.installed === false ? '未检测到' : t.exec ? '可回答 · 可实施' : '只回答'}>
              <select value={t.modelOverride ?? ''} onChange={(e) => void save('models', e.target.value || undefined, t.id)}>
                <option value="">继承配置{t.model && !t.modelOverride ? `（${t.model}）` : ''}</option>
                {t.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <select value={t.reasoningEffort ?? 'default'} disabled={!t.efforts.length} title={t.efforts.length ? '' : '此模型或接口未提供可配置的思考档位'}
                onChange={(e) => void save('reasoningEffort', e.target.value, t.id)}>
                <option value="default">{t.efforts.length ? '默认强度' : '不支持'}</option>
                {t.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <button className="btn" disabled={t.test?.status === 'testing' || !!ws.configError}
                aria-label={`测试 ${t.label}（${t.id}）可用性`}
                onClick={() => void unify.testTarget(t.id).catch(err => notify(errText(err), 'err'))}>
                {t.test?.status === 'testing' ? <><Spinner />测试中…</> : '测试可用性'}
              </button>
            </Row>
            {t.test && t.test.status !== 'testing' && (
              <p role="status" className={t.test.status === 'passed' ? 'ok-text' : 'err-text'}>
                {t.test.status === 'failed' && '测试失败 · '}{t.test.message}
              </p>
            )}
          </div>
        ))}
      </Section>

      <Section title="回答、汇总与执行">
        <Row label="默认回答目标" hint={providers ? '固定为下面勾选的目标' : '自动：所有可用目标（不含决策模型）'}>
          <Switch label="自动选择" checked={!providers} onChange={(auto) => void save('providers', auto ? undefined : ws.defaults.length ? ws.defaults : ws.targets.slice(0, 1).map((t) => t.id))} />
        </Row>
        {providers && (
          <div className="checks">
            {ws.targets.map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={providers.includes(t.id)} onChange={(e) => {
                  const next = e.target.checked ? [...providers, t.id] : providers.filter((p) => p !== t.id);
                  if (next.length) void save('providers', next); else notify('至少保留一个目标', 'err');
                }} />
                {t.label}
              </label>
            ))}
          </div>
        )}
        {([['synthesizer', '汇总模型', '汇总多个回答；不可用时使用第一个成功的回答目标'], ['executor', '执行模型', '按方案修改文件，只能选择支持实施的目标'], ['decider', '决策模型', '决定每轮由哪些目标回答、是否汇总']] as const).map(([key, title, hint]) => (
          <Row key={key} label={title} hint={hint}>
            <select value={cfg[key] ?? ''} onChange={(e) => void save(key, e.target.value || undefined)}>
              <option value="">{key === 'decider' ? '不使用' : '默认'}</option>
              {ws.targets.filter((t) => key !== 'executor' || t.exec).map((t) => <option key={t.id} value={t.id}>{label(t.id)}</option>)}
            </select>
          </Row>
        ))}
      </Section>

      <Section title="并发与超时" note="留空恢复默认值。">
        {([['concurrency', '回答并发数', 3], ['timeoutSec', '回答与汇总超时（秒）', 600], ['decisionTimeoutSec', '决策超时（秒）', 60], ['execTimeoutSec', '执行超时（秒）', 3600]] as const).map(([key, title, fallback]) => (
          <Row key={key} label={title}><NumberField value={cfg[key]} fallback={fallback} onSave={(v) => void save(key, v)} /></Row>
        ))}
      </Section>

      <Section title="界面">
        <Row label="显示思考过程" hint="生成时默认展开模型的思考内容"><Switch label="显示思考过程" checked={cfg.showReasoning ?? false} onChange={(v) => void save('showReasoning', v)} /></Row>
      </Section>

      <Section title="高级" note={<>目标别名写入项目配置；自定义端点与额度命令只从用户配置加载。<button className="link" onClick={() => void unify.reveal('project-config')}>项目配置文件</button><button className="link" onClick={() => void unify.reveal('user-config')}>用户配置文件</button></>}>
        <Row label="禁用 Claude Code" hint="包括版本检测和基于 Claude 的目标"><Switch label="禁用 Claude Code" checked={cfg.disableClaude ?? false} onChange={(v) => void save('disableClaude', v)} /></Row>
        <div className="set-block"><div className="set-label"><div>目标别名 <code>targets</code></div><small>同一个 provider 可以配置多个模型或思考强度</small></div><JsonField value={info.project.targets} onSave={(v) => void save('targets', v)} /></div>
        <div className="set-block"><div className="set-label"><div>自定义端点与命令 <code>custom</code></div><small>OpenAI 兼容端点或本地命令，仅用户配置</small></div><JsonField value={info.user.custom} onSave={(v) => void save('custom', v)} /></div>
        <div className="set-block"><div className="set-label"><div>额度查询命令 <code>quotaCommands</code></div><small>按 provider id 配置，仅用户配置</small></div><JsonField value={info.user.quotaCommands} onSave={(v) => void save('quotaCommands', v)} /></div>
      </Section>
    </div>
  );
}
