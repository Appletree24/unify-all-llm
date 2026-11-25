import { useEffect, useState } from 'react';
import type { CacheReport } from '../shared/api.js';
import { unify } from './api.js';
import { Spinner } from './ui.js';

const stages: Record<string, string> = {
  answer: '回答', decision: '路由', 'dispute-assessment': '分歧判断', 'source-check': '原文核查', synthesis: '汇总',
  'plan-review': '方案复核', exec: '执行', 'result-review': '执行复核', report: '结果汇报', benchmark: '评测', distill: '记忆提炼', 'model-check': '模型检查',
};

export function CachePage() {
  const [report, setReport] = useState<CacheReport>();
  const [error, setError] = useState('');
  const [warningsOnly, setWarningsOnly] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await unify.cacheReport();
        if (active) { setReport(next); setError(''); }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  const rows = report?.calls.filter(c => !warningsOnly || c.warnings.length);
  return <div className="page cache-page">
    <div className="cache-content">
      <header className="page-head"><div><h1>缓存监控</h1><p className="lede">所有项目 · 近 7 天内的最近 100 次调用</p></div></header>
      {error && <p role="alert" className="error">{error}</p>}
      {!report && !error && <div className="pending"><Spinner />正在读取缓存记录…</div>}
      {report && <>
        <dl className="cache-totals">
          <div><dt>缓存读取 tokens</dt><dd>{report.reported ? report.cachedTokens.toLocaleString() : '—'}
            <small>{report.reported} / {report.calls.length} 次调用已上报</small></dd></div>
          <div><dt>发送前预警</dt><dd>{report.preflightAlerts}</dd></div>
          <div><dt>读数异常提醒</dt><dd>{report.usageAlerts}</dd></div>
        </dl>
        <section aria-labelledby="cache-history-title">
          <div className="cache-history-head">
            <h2 id="cache-history-title">调用记录</h2>
            <label className="cache-filter"><input type="checkbox" checked={warningsOnly} onChange={e => setWarningsOnly(e.target.checked)} />只看预警</label>
          </div>
          {rows?.length ? <div className="cache-scroll"><table className="cache-history" aria-labelledby="cache-history-title">
            <thead><tr><th>更新时间 / 项目</th><th>模型 / 阶段</th><th>前缀与预警</th><th className="cache-reading">缓存读取</th></tr></thead>
            <tbody>{rows.map(c => <tr key={c.id}>
              <td><time dateTime={new Date(c.updatedAt ?? c.at).toISOString()}>{new Date(c.updatedAt ?? c.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                <small title={c.project}>{c.project.split(/[\\/]/).filter(Boolean).pop() ?? c.project}</small></td>
              <td>{c.model ?? c.target}<small title={c.id}>{c.target} · {stages[c.scope] ?? c.scope}</small></td>
              <td>{c.comparison}{c.matchedBytes !== undefined && <small>{c.matchedBytes.toLocaleString()} / {c.expectedBytes?.toLocaleString()} 字节</small>}
                {c.warnings.map(w => <small className="cache-warning" key={w}>{w}</small>)}</td>
              <td className={'cache-reading' + (c.cachedTokens === undefined ? ' faint' : c.usageAlert ? ' cache-warning' : '')}>
                {c.cachedTokens !== undefined ? c.cachedTokens.toLocaleString() + ' tokens' : c.phase === 'submitted' ? '尚无终态' : '未上报'}</td>
            </tr>)}</tbody>
          </table></div> : <p className="cache-empty">{warningsOnly ? '最近的调用没有预警' : '还没有缓存记录。下一次模型调用会显示在这里。'}</p>}
        </section>
      </>}
    </div>
  </div>;
}
