import { z } from 'zod';
import { confirmedExcerpts, readJsonReply } from './source-check.js';
import type { AdvisorReview } from './advisor.js';

const replySchema = z.object({
  verdict: z.enum(['confirmed', 'disputed', 'insufficient']), finding: z.string().trim().min(1).max(4000),
  excerpts: z.array(z.unknown()).max(4).default([]), quotes: z.array(z.string().trim().min(1).max(2400)).max(4).default([]),
});

export function checkAdvisorReply(text: string, claim: string, material: string, project?: string):
Pick<AdvisorReview, 'status' | 'finding' | 'evidence'> {
  const parsed = replySchema.safeParse(readJsonReply(text));
  if (!parsed.success) return { status: 'failed', finding: '顾问未返回可识别的复核结果。' };
  const { verdict, finding, quotes, excerpts } = parsed.data;
  const files = project ? confirmedExcerpts(project, JSON.stringify(excerpts)) : [];
  const matched = quotes.filter(q => material.includes(q));
  const evidence = [...files.map(e => e.path + ':' + e.line + ' — ' + e.quote), ...matched.map(q => '输入材料 — ' + q)];
  if (verdict === 'insufficient') return { status: verdict, finding, evidence };
  if (!evidence.length || matched.length !== quotes.length || files.length !== excerpts.length) {
    return { status: 'insufficient', finding: '顾问的引文未能与项目文件或输入材料匹配，结论尚待核实。', evidence };
  }
  // Test definitions can explain coverage. A claim about a completed run needs output from the run.
  if (verdict === 'confirmed' && /(?:测试|用例).{0,12}(?:通过|跑通)|\b(?:tests?|test suite) (?:all )?(?:pass(?:ed)?|succeeded)\b/iu.test(claim)) {
    const outputs = [...matched, ...files.filter(f => /\.(?:log|tap)$/iu.test(f.path)).map(f => f.quote)];
    const pass = /\b(?:pass(?:ed)?|ok|succeeded|success)\b|通过/iu;
    const failure = /\bnot ok\b|\b(?:[1-9]\d*\s+fail(?:ed|ures?)?|fail(?:ed|ures?)?\s*[:=]?\s*[1-9]\d*)\b|未通过|失败\s*[:：]?\s*[1-9]/iu;
    if (!outputs.some(q => pass.test(q)) || outputs.some(q => failure.test(q))) {
      return { status: 'insufficient', finding: '缺少支持测试通过的运行结果。请提供该次测试的输出。', evidence };
    }
  }
  return { status: verdict, finding, evidence };
}
