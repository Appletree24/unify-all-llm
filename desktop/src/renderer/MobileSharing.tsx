import { useEffect, useRef, useState } from 'react';
import { toCanvas } from 'qrcode';
import type { MobileNetwork, MobileShareInfo } from '../../../src/mobile/types.js';
import { onPush, unify } from './api.js';
import { useAnimatedDialog } from './motion.js';
import { Icon } from './ui.js';

function ShareDialog({ cwd, sessionId, share, networks, close }: {
  cwd: string; sessionId: string | null; share: MobileShareInfo | null; networks: MobileNetwork[]; close(): void;
}) {
  const ref = useAnimatedDialog(true);
  const qr = useRef<HTMLCanvasElement>(null);
  const [address, setAddress] = useState(networks[0]?.address ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
    if (share && qr.current) void toCanvas(qr.current, share.url, { width: 224, margin: 4 }).catch(() => setError('二维码生成失败，可以复制连接链接'));
  }, [share?.url]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} className="modal session-dialog share-dialog" aria-labelledby="share-title" onCancel={close}>
    <header><h2 id="share-title">手机共享</h2><button className="tb-btn" onClick={close} aria-label="关闭"><Icon name="x" /></button></header>
    {share ? <>
      <p className="lede">用手机相机扫码，查看回答并继续追问。</p>
      <canvas ref={qr} aria-label="当前会话的连接二维码" />
      <strong className="share-title">{share.title}</strong>
      <small>{new URL(share.url).host}</small>
      <div className="modal-acts">
        <button className="btn danger" disabled={busy} onClick={() => void act(() => unify.stopSharing(share.cwd, share.sessionId))}>停止共享</button>
        <button className="btn" disabled={busy} onClick={() => void act(async () => { await unify.copy(share.url); setCopied(true); })}>{copied ? '已复制' : '复制连接链接'}</button>
      </div>
    </> : <>
      <p className="lede">持有链接的人可以查看这段会话，并向电脑上的模型追问。</p>
      <label className="share-network">电脑的连接地址<select value={address} onChange={e => setAddress(e.target.value)}>
        {networks.map(n => <option key={n.name + n.address} value={n.address}>{n.name} · {n.address}</option>)}
      </select></label>
      <p className="lede">{networks.length ? '同一可信 Wi-Fi 可直接连接。手机使用蜂窝网络时，请选择两端共用的私有 VPN 地址。' : '未找到可用地址。请接入 Wi-Fi 或私有 VPN 后重新打开。'}</p>
      <div className="modal-acts"><button className="btn" disabled={busy || !address || !sessionId}
        onClick={() => sessionId && void act(() => unify.shareSession(cwd, sessionId, address))}>{busy ? '正在开启…' : '共享当前会话'}</button></div>
    </>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </dialog>;
}

export function MobileSharing({ cwd, sessionId, onError }: { cwd: string; sessionId: string | null; onError(message: string): void }) {
  const [share, setShare] = useState<MobileShareInfo | null>(null);
  const [networks, setNetworks] = useState<MobileNetwork[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    const unsubscribe = onPush(event => {
      if (event.type === 'mobile-sharing') { current = false; setShare(event.share); }
    });
    void unify.mobileSharing().then(info => { if (current) setShare(info.share); }, () => {});
    return () => { current = false; unsubscribe(); };
  }, []);
  async function show() {
    try {
      const info = await unify.mobileSharing();
      setShare(info.share);
      setNetworks(info.networks);
      setOpen(true);
    } catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  }
  return <>
    <button className={'tb-project share-button' + (share ? ' sharing' : '')} disabled={!sessionId && !share}
      title={share ? '管理已共享的会话' : sessionId ? '用手机继续当前会话' : '打开一段对话后即可共享'} onClick={() => void show()}>
      <Icon name="phone" size={14} />{share ? '共享中' : '手机共享'}
    </button>
    {open && <ShareDialog cwd={cwd} sessionId={sessionId} share={share} networks={networks} close={() => setOpen(false)} />}
  </>;
}
