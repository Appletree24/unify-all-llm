import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { RunRecord, StagedMaterial } from '../shared/api.js';
import { unify } from './api.js';
import { Icon, Spinner } from './ui.js';

interface DraftMaterial { item: StagedMaterial; note: string; url?: string }
const maxBytes = 64 * 1024 * 1024;
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

export function useMaterialInput(cwd: string) {
  const [drafts, setDrafts] = useState<DraftMaterial[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState('');
  const [expanded, setExpanded] = useState('');
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const active = useRef(false);
  const recordingLock = useRef(false);
  const ids = useRef(new Map<string, string | undefined>());
  const slots = useRef(0);
  const release = (id: string) => {
    const url = ids.current.get(id);
    if (url) URL.revokeObjectURL(url);
    ids.current.delete(id);
    void unify.discardMaterial(cwd, id).catch(() => {});
  };
  function clear() {
    for (const id of ids.current.keys()) release(id);
    slots.current = 0;
    setDrafts([]); setExpanded(''); setError('');
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      for (const id of ids.current.keys()) release(id);
    };
  }, [cwd]);
  async function add(files: File[]) {
    setError('');
    if (files.length + slots.current > 12) { setError('每轮最多添加 12 份材料'); return; }
    slots.current += files.length;
    setPending(n => n + files.length);
    for (const file of files) {
      try {
        if (!active.current) return;
        if (!file.size || file.size > maxBytes) throw new Error(file.name + ' 需要在 1 B 到 64 MB 之间');
        const item = await unify.stageMaterial(cwd, file.name, file.type, await file.arrayBuffer());
        if (!active.current) { void unify.discardMaterial(cwd, item.id); return; }
        const url = /^(image|video|audio)\//.test(item.mime)
          ? URL.createObjectURL(file.type === item.mime ? file : file.slice(0, file.size, item.mime)) : undefined;
        ids.current.set(item.id, url);
        setDrafts(prev => [...prev, { item, url, note: '' }]);
        setExpanded(item.id);
      } catch (err) { slots.current--; if (active.current) setError(message(err)); }
      finally { if (active.current) setPending(n => n - 1); }
    }
  }
  function remove(id: string) {
    release(id); slots.current--;
    setDrafts(prev => prev.filter(d => d.item.id !== id));
    setExpanded(value => value === id ? '' : value);
  }
  async function record(screen: boolean) {
    if (recordingLock.current) return;
    recordingLock.current = true;
    setError(''); setRecording('等待授权');
    let stream: MediaStream | undefined;
    try {
      stream = screen ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        : await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const tracks = stream.getTracks();
      if (!active.current) { tracks.forEach(track => track.stop()); return; }
      const formats = screen ? ['video/mp4', 'video/webm'] : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
      const mimeType = formats.find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, { mimeType, ...(screen ? { videoBitsPerSecond: 1500000 } : {}) });
      recorder.current = rec;
      const chunks: Blob[] = [];
      let size = 0;
      rec.ondataavailable = e => {
        if (!e.data.size) return;
        chunks.push(e.data); size += e.data.size;
        if (size >= maxBytes - 2 * 1024 * 1024 && rec.state === 'recording') rec.stop();
      };
      rec.onstop = () => {
        tracks.forEach(track => track.stop());
        recorder.current = undefined; recordingLock.current = false;
        if (!active.current) return;
        setRecording('');
        const mime = (chunks[0]?.type || rec.mimeType).split(';')[0];
        const ext = mime.includes('mp4') ? screen ? 'mp4' : 'm4a' : 'webm';
        const name = (screen ? '操作示范-' : '语音-') + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
        void add([new File(chunks, name, { type: mime })]);
      };
      rec.onerror = () => { setError('录制中断，请检查设备权限'); if (rec.state !== 'inactive') rec.stop(); };
      tracks.forEach(track => { track.onended = () => { if (rec.state === 'recording') rec.stop(); }; });
      rec.start(500); setRecording(screen ? '正在录制示范' : '正在录音');
    } catch (err) {
      stream?.getTracks().forEach(track => track.stop());
      recordingLock.current = false;
      if (active.current) { setRecording(''); setError('无法开始录制 · ' + message(err)); }
    }
  }
  function paste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); void add(files); }
  }
  function drop(e: DragEvent) {
    if (e.dataTransfer.files.length) { e.preventDefault(); void add(Array.from(e.dataTransfer.files)); }
  }
  return { drafts, pending, error, recording, expanded, setExpanded, add, record, remove, clear, paste, drop,
    stop: () => { if (recorder.current?.state === 'recording') recorder.current.stop(); },
    updateNote: (id: string, note: string) => setDrafts(prev => prev.map(d => d.item.id === id ? { ...d, note } : d)),
  };
}

export function MaterialInput({ input, disabled }: { input: ReturnType<typeof useMaterialInput>; disabled: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const detail = input.drafts.find(d => d.item.id === input.expanded);
  return <div className="material-input">
    <div className="input-tools">
      <input ref={picker} type="file" multiple hidden onChange={e => { void input.add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <button type="button" disabled={disabled} onClick={() => picker.current?.click()} title="选择文件，也可以粘贴或拖入"><Icon name="plus" size={14} />文件</button>
      <button type="button" disabled={disabled} aria-expanded={linkOpen} onClick={() => setLinkOpen(v => !v)}>链接</button>
      <button type="button" disabled={disabled || !!input.recording} onClick={() => void input.record(false)}>录音</button>
      <button type="button" disabled={disabled || !!input.recording} onClick={() => void input.record(true)}>录制示范</button>
      {input.recording && <button className="record-stop" type="button" disabled={input.recording === '等待授权'} onClick={input.stop}>
        <Icon name="stop" size={12} />{input.recording}{input.recording !== '等待授权' && ' · 停止'}</button>}
      {!!input.pending && <span role="status"><Spinner />正在读取材料</span>}
    </div>
    {linkOpen && <form className="input-link" onSubmit={e => {
      e.preventDefault();
      const url = new URL(link); if (!['https:', 'http:'].includes(url.protocol)) return;
      void input.add([new File([url.href], url.hostname + '.url.txt', { type: 'text/plain' })]); setLinkOpen(false); setLink('');
    }}><input type="url" pattern="https?://.+" required aria-label="材料链接" placeholder="https://…" value={link} onChange={e => setLink(e.target.value)} />
      <button className="btn" disabled={disabled}>附上网址</button></form>}
    {input.drafts.length > 0 && <div className="material-chips">{input.drafts.map(({ item }) =>
      <span key={item.id}><button type="button" aria-expanded={input.expanded === item.id} onClick={() => input.setExpanded(input.expanded === item.id ? '' : item.id)}>{item.name}</button>
        <button type="button" disabled={disabled} title={'移除 ' + item.name} onClick={() => input.remove(item.id)}><Icon name="x" size={12} /></button></span>)}</div>}
    {detail && <div className="material-detail">
      {detail.url && (detail.item.mime.startsWith('audio/') ? <audio src={detail.url} controls />
        : detail.item.mime.startsWith('video/') ? <video src={detail.url} controls /> : <img src={detail.url} alt={detail.item.name} />)}
      <details key={detail.item.id}><summary>{detail.item.extraction}</summary>{detail.item.text && <pre>{detail.item.text}</pre>}</details>
      <input aria-label="材料说明" disabled={disabled} value={detail.note} placeholder="补充说明、转写或操作步骤…" onChange={e => input.updateNote(detail.item.id, e.target.value)} />
    </div>}
    {input.error && <div role="alert" className="input-error">{input.error}</div>}
  </div>;
}

export function SavedMaterials({ record }: { record: RunRecord }) {
  const [error, setError] = useState('');
  if (!record.input.materials?.length) return null;
  return <div className="saved-materials">{record.input.materials.map((m, index) => <details key={index}>
    <summary>{m.name} <small>{m.extraction}</small></summary>
    {m.note && <p>{m.note}</p>}
    {m.text && <pre>{m.text}</pre>}
    <button className="btn" onClick={() => void unify.revealMaterial(record.input.cwd, record.id, index).catch(err => setError(message(err)))}>在文件夹中显示原件</button>
  </details>)}{error && <span role="alert">{error}</span>}</div>;
}
