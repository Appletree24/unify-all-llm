import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { QuotaLimit, QuotaReader, QuotaReading } from './types.js';

const endpoint = 'https://cloudcode-pa.googleapis.com';
const oauthType = 'oauth-personal';
const refreshHint = '请打开 Gemini CLI 刷新 Google 登录后重试';
const safeLabel = z.string().min(1).max(180).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);

async function optionalJson(path: string, signal: AbortSignal, settings = false) {
  try {
    let raw = await readFile(path, { encoding: 'utf8', signal });
    if (settings) {
      // Gemini accepts JSON comments in settings. Preserve quoted strings containing URLs.
      raw = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
        match => match.startsWith('/') ? ' ' : match);
    }
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function usesGoogleLogin(dir: string, cwd: string, signal: AbortSignal): Promise<boolean> {
  const systemDir = process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli'
    : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
  const systemPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || join(systemDir, 'settings.json');
  const paths = [
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || join(dirname(systemPath), 'system-defaults.json'),
    join(dir, 'settings.json'), join(cwd, '.gemini', 'settings.json'), systemPath,
  ];
  const [defaults, user, workspace, system] = await Promise.all(paths.map(async path => {
    const settings = await optionalJson(path, signal, true);
    return settings?.security?.auth ?? {};
  }));
  if (process.env.GEMINI_CLI_AUTH_OVERRIDE) {
    user.selectedType = process.env.GEMINI_CLI_AUTH_OVERRIDE;
  }
  const base = { ...defaults, ...user, ...system };
  const merged = { ...defaults, ...user, ...workspace, ...system };
  const selected = (auth: typeof base) => auth.selectedType ?? (
    process.env.GOOGLE_GENAI_USE_GCA === 'true' ? oauthType : undefined
  );
  // An untrusted workspace may be ignored by the CLI. Only use the account if both
  // interpretations select Google login, including any enforced system auth type.
  return [base, merged].every(auth => selected(auth) === oauthType
    && (!auth.enforcedType || auth.enforcedType === oauthType) && !auth.useExternal);
}

const bucket = z.object({
  modelId: safeLabel.optional(),
  tokenType: safeLabel.optional(),
  remainingFraction: z.number().min(0).max(1).optional(),
  remainingAmount: z.string().regex(/^\d+$/).optional(),
  resetTime: z.iso.datetime({ offset: true }).optional(),
});

function bucketLimit(value: unknown): QuotaLimit | undefined {
  const result = bucket.safeParse(value);
  if (!result.success) return;
  const { modelId, tokenType, remainingFraction, remainingAmount, resetTime } = result.data;
  const label = [modelId, tokenType].filter(Boolean).join(' · ') || 'Code Assist';
  const timing = resetTime ? { resetsAt: resetTime } : {};
  if (remainingFraction !== undefined) {
    return { label, remaining: Number((remainingFraction * 100).toPrecision(14)), unit: '%', ...timing };
  }
  if (remainingAmount !== undefined && Number.isSafeInteger(Number(remainingAmount))) {
    return { label: modelId || 'Code Assist', remaining: Number(remainingAmount), unit: tokenType || '单位', ...timing };
  }
}

async function httpError(res: Response): Promise<QuotaReading> {
  await res.body?.cancel();
  return { status: 'error', message: `Google Code Assist 返回 HTTP ${res.status}${res.status === 401 ? '，' + refreshHint : ''}` };
}

// Mirrors Gemini CLI's code_assist/{setup,server,types}. Query only the quota
// endpoints and use an existing access token, leaving credential refresh to the CLI.
export const readGeminiQuota: QuotaReader = async ({ cwd, signal }) => {
  const dir = join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini');
  if (!await usesGoogleLogin(dir, cwd, signal)) {
    return { status: 'unavailable', message: '内置额度查询支持 Gemini CLI 的 Google 登录模式；其他模式可配置 quotaCommands.gemini' };
  }
  if ((process.env.CODE_ASSIST_ENDPOINT && process.env.CODE_ASSIST_ENDPOINT !== endpoint) ||
      (process.env.CODE_ASSIST_API_VERSION && process.env.CODE_ASSIST_API_VERSION !== 'v1internal')) {
    return { status: 'unavailable', message: '自定义 Code Assist 接口可配置 quotaCommands.gemini' };
  }
  // Gemini tests for "true" when selecting the auth type from the environment,
  // then tests for a nonempty GCA flag when selecting its OAuth token override.
  let token = process.env.GOOGLE_GENAI_USE_GCA && process.env.GOOGLE_CLOUD_ACCESS_TOKEN;
  if (!token) {
    if (process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === 'true') {
      return { status: 'unavailable', message: 'Gemini 使用加密凭证，可配置 quotaCommands.gemini' };
    }
    const creds = await optionalJson(join(dir, 'oauth_creds.json'), signal);
    if (typeof creds?.access_token !== 'string' || !creds.access_token || creds.expiry_date <= Date.now()) {
      return { status: 'unavailable', message: refreshHint };
    }
    token = creds.access_token;
  }
  const request = (method: string, body: object) => fetch(`${endpoint}/v1internal:${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal,
  });
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  const setup = await request('loadCodeAssist', {
    cloudaicompanionProject: envProject,
    metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', duetProject: envProject },
  });
  if (!setup.ok) return httpError(setup);
  const account = await setup.json();
  const project = account?.cloudaicompanionProject || envProject;
  if (typeof project !== 'string' || !project) {
    return { status: 'unavailable', message: '无法确定 Gemini CLI 的 Code Assist 项目，请检查 Google 登录及 GOOGLE_CLOUD_PROJECT' };
  }
  const res = await request('retrieveUserQuota', { project });
  if (!res.ok) return httpError(res);
  const data = await res.json();
  if (!Array.isArray(data?.buckets)) return { status: 'error', message: 'Google 未返回有效的配额数据' };
  const limits = data.buckets.map(bucketLimit).filter((limit: QuotaLimit | undefined) => limit !== undefined);
  return limits.length ? { status: 'ok', limits } : { status: 'unavailable', message: 'Google 未提供可读的模型剩余额度' };
};
