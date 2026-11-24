import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const id = z.string().regex(/^[a-z][\w-]*$/i).refine((s) => !['__proto__', 'constructor', 'prototype'].includes(s), '保留名称');
const text = z.string().trim().min(1);
export const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof effortSchema>;
const seconds = z.number().positive().max(2_147_483);
export const customSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('openai'), label: text.optional(), baseUrl: z.url().refine((s) => {
      const u = new URL(s);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    }, '需要不含凭证、查询参数或片段的 HTTP(S) URL'),
    model: text, apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), system: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('command'), label: text.optional(), command: text, args: z.array(z.string()).optional(), interactive: z.boolean().optional() }),
]);
const memorySchema = z.strictObject({
  projectSource: z.enum(['auto', 'AGENTS.md', 'CLAUDE.md', '.unify/memory.md', 'off']).optional(),
  userEnabled: z.boolean().optional(),
  userPath: text.optional(),
  userAllowTargets: z.array(id).optional(),
  maxBytes: z.number().int().min(1024).max(256 * 1024).optional(),
});
const schema = z.strictObject({
  showReasoning: z.boolean().optional(), mouse: z.boolean().optional(),
  disableClaude: z.boolean().optional(),
  providers: z.array(id).min(1).refine((a) => new Set(a).size === a.length, '目标不能重复').optional(),
  synthesizer: id.optional(), executor: id.optional(), decider: id.optional(),
  reasoningEffort: z.record(id, z.union([effortSchema, z.literal('default')])).optional(),
  models: z.record(id, text).optional(),
  targets: z.record(id, z.strictObject({ provider: id, model: text.optional(), reasoningEffort: effortSchema.optional(), label: text.optional() })).optional(),
  timeoutSec: seconds.optional(), execTimeoutSec: seconds.optional(), decisionTimeoutSec: seconds.optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  custom: z.record(id, customSchema).optional(),
  quotaCommands: z.record(id, z.strictObject({ command: text, args: z.array(z.string()).optional() })).optional(),
  memory: memorySchema.optional(),
});
export type Config = z.infer<typeof schema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
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
  return mergeConfig(user, project);
}

export function mergeConfig(user: Config, project: Config): Config {
  const memory: MemoryConfig | undefined = (user.memory || project.memory) ? {
    // User-level memory disclosure is trusted ONLY from user config.
    ...(user.memory?.userEnabled !== undefined ? { userEnabled: user.memory.userEnabled } : {}),
    ...(user.memory?.userPath !== undefined ? { userPath: user.memory.userPath } : {}),
    ...(user.memory?.userAllowTargets !== undefined ? { userAllowTargets: user.memory.userAllowTargets } : {}),
    ...(project.memory?.projectSource ?? user.memory?.projectSource ? { projectSource: project.memory?.projectSource ?? user.memory?.projectSource } : {}),
    ...(project.memory?.maxBytes ?? user.memory?.maxBytes ? { maxBytes: project.memory?.maxBytes ?? user.memory?.maxBytes } : {}),
  } : undefined;
  return removeRetiredGemini({
    ...user, ...project, custom: user.custom, quotaCommands: user.quotaCommands,
    disableClaude: user.disableClaude === true || project.disableClaude === true,
    reasoningEffort: { ...user.reasoningEffort, ...project.reasoningEffort },
    models: { ...user.models, ...project.models }, targets: { ...user.targets, ...project.targets },
    ...(memory && Object.keys(memory).length ? { memory } : {}),
  });
}

function removeRetiredGemini(config: Config): Config {
  // A user-defined transport can reuse the former provider id.
  if (config.custom?.gemini) return config;

  const retiredIds = new Set(Object.entries(config.targets ?? {})
    .filter(([, target]) => target.provider === 'gemini')
    .map(([id]) => id));
  if (!config.targets?.gemini) retiredIds.add('gemini');

  for (const id of retiredIds) {
    delete config.targets?.[id];
    delete config.models?.[id];
    delete config.reasoningEffort?.[id];
  }
  for (const field of ['synthesizer', 'executor', 'decider'] as const) {
    const id = config[field];
    if (id && retiredIds.has(id)) delete config[field];
  }
  if (config.providers) {
    const providers = config.providers.filter(id => !retiredIds.has(id));
    if (providers.length) config.providers = providers;
    else delete config.providers;
  }
  if (config.quotaCommands?.gemini) {
    config.quotaCommands = { ...config.quotaCommands };
    delete config.quotaCommands.gemini;
  }
  return config;
}

export function timeoutMillis(seconds: number): number {
  return z.number().positive().max(2_147_483).parse(seconds) * 1000;
}
