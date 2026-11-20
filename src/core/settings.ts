import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWrite } from './atomic-write.js';
import { mergeConfig, parseConfig, readJson, type Config } from './config.js';
import type { ModelTarget } from './types.js';
import { buildRegistry } from '../providers/index.js';

export type SettingField = keyof Config;
/** Transports and quota commands run local code, so they are trusted only from the user layer. */
export const userField = (field: SettingField) => field === 'custom' || field === 'quotaCommands';
export const userConfigPath = () => join(homedir(), '.unify', 'config.json');
export const projectConfigPath = (cwd: string) => join(cwd, 'unify.config.json');

/** Read the current layers before each edit; validate the merged registry before replacing the file. */
export function writeSetting(cwd: string, key: SettingField, value: unknown, entry?: string): { cfg: Config; targets: ModelTarget[] } {
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd);
  const user = parseConfig(readJson(userPath) ?? {}, userPath);
  const project = parseConfig(readJson(projectPath) ?? {}, projectPath);
  const global = userField(key);
  const original = global ? user : project;
  if (entry !== undefined) {
    const map = { ...(original[key] as Record<string, unknown>), [entry]: value };
    if (value === undefined) delete map[entry];
    value = Object.keys(map).length ? map : undefined;
  }
  if (key === 'disableClaude' && user.disableClaude && value === false) throw new Error('Claude Code 已在 ~/.unify/config.json 中禁用');
  const next = parseConfig({ ...original, [key]: value });
  const cfg = global ? mergeConfig(next, project) : mergeConfig(user, next);
  const targets = Object.values(buildRegistry(cfg));
  const path = global ? userPath : projectPath;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, JSON.stringify(next, null, 2) + '\n');
  return { cfg, targets };
}
