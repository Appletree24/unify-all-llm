import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const id = z.string().regex(/^[a-z][\w-]*$/i).refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s), '保留名称');
const text = z.string().trim().min(1);
const seconds = z.number().positive().max(2_147_483);
export const customSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('openai'), label: text.optional(), baseUrl: z.url().refine((s) => {
      const u = new URL(s);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    }, '需要不含凭证、查询参数或片段的 HTTP(S) URL'),
    model: text, apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), system: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('command'), label: text.optional(), command: text, args: z.array(z.string()).optional() }),
]);
const schema = z.strictObject({
  disableClaude: z.boolean().optional(),
  providers: z.array(id).min(1).refine((a) => new Set(a).size === a.length, '目标不能重复').optional(),
  synthesizer: id.optional(), executor: id.optional(), decider: id.optional(),
  models: z.record(id, text).optional(),
  targets: z.record(id, z.strictObject({ provider: id, model: text.optional(), label: text.optional() })).optional(),
  timeoutSec: seconds.optional(), execTimeoutSec: seconds.optional(), decisionTimeoutSec: seconds.optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  custom: z.record(id, customSchema).optional(),
});
export type Config = z.infer<typeof schema>;
export type CustomProviderConfig = z.infer<typeof customSchema>;

export function parseConfig(value: unknown, source = '配置'): Config {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${source}: ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
  return result.data;
}

export function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return undefined;
    throw new Error(`无法读取 JSON: ${path}`, { cause: err });
  }
}

/** Custom transports are trusted only from the user config. Disable is monotonic. */
export function loadConfig(cwd: string): Config {
  const userPath = join(homedir(), '.unify', 'config.json');
  const projectPath = join(cwd, 'unify.config.json');
  const user = parseConfig(readJson(userPath) ?? {}, userPath);
  const project = parseConfig(readJson(projectPath) ?? {}, projectPath);
  return {
    ...user, ...project, custom: user.custom,
    disableClaude: user.disableClaude === true || project.disableClaude === true,
    models: { ...user.models, ...project.models }, targets: { ...user.targets, ...project.targets },
  };
}

export function timeoutMillis(seconds: number): number {
  return z.number().positive().max(2_147_483).parse(seconds) * 1000;
}
