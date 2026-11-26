import type { ReasoningEffort } from '../core/config.js';
import { effortLabel } from './effort.js';

export const isAgyProvider = (provider: string, askPolicy: string) =>
  provider === 'gemini-pro' && askPolicy === 'provider-plan';

const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortInId = (id?: string) => levels.find(level => id?.endsWith('-' + level));
export function agyModelFamily(id: string): string {
  const effort = effortInId(id);
  return effort ? id.slice(0, -(effort.length + 1)) : id;
}
export interface AgyModel {
  id: string;
  family: string;
  label: string;
  effort?: typeof levels[number];
}

export function parseAgyModels(output: string): AgyModel[] {
  const models = new Map<string, AgyModel>();
  for (const line of output.split(/\r?\n/)) {
    const row = /^(\S+)\t+(.+)$/.exec(line.trim());
    if (!row) continue;
    const [, id, name] = row;
    const effort = effortInId(id);
    const family = agyModelFamily(id);
    const label = effort ? name.replace(/\s+\((low|medium|high|xhigh|max)\)$/i, '') : name;
    models.set(id, { id, family, effort, label });
  }
  if (!models.size) throw new Error('agy models 未返回模型列表');
  return [...models.values()];
}

interface SettingChoice { value: string; label: string }
interface ModelSettings {
  models: SettingChoice[];
  efforts: SettingChoice[];
  effortField: 'models' | 'reasoningEffort';
  effortValue: string;
  storedEffort?: string;
}

/** Each agy menu value is a complete, advertised ID usable in both ACP and print mode. */
export function modelSettings(
  target: { models: string[]; model?: string; efforts: readonly ReasoningEffort[]; reasoningEffort?: ReasoningEffort },
  catalog?: readonly AgyModel[],
): ModelSettings {
  const option = (value: string, label = value) => ({ value, label });
  if (!catalog) return {
    models: target.models.map(id => option(id)),
    efforts: target.efforts.length ? [option('default', '默认强度'), ...target.efforts.filter(e => e !== 'none').map(e => option(e))] : [],
    effortField: 'reasoningEffort', effortValue: target.reasoningEffort ?? 'default',
    storedEffort: target.reasoningEffort && effortLabel(target.reasoningEffort),
  };

  const families = new Map<string, AgyModel[]>();
  for (const model of catalog) {
    const variants = families.get(model.family);
    if (variants) variants.push(model);
    else families.set(model.family, [model]);
  }
  const current = catalog.find(m => m.id === target.model);
  const models = [...families.values()].map(variants => {
    const pick = variants.find(m => m.effort === current?.effort) ?? variants.find(m => !m.effort)
      ?? variants.find(m => m.effort === 'medium') ?? variants[0];
    return option(pick.id, pick.label);
  });
  // Also keep configured IDs from older catalogs, including target aliases.
  const configured = target.model ? [target.model, ...target.models] : target.models;
  for (const id of configured) {
    if (!catalog.some(m => m.id === id) && !models.some(m => m.value === id)) models.push(option(id));
  }
  const variants = current ? families.get(current.family)! : [];
  const efforts = variants.some(m => m.effort) ? [undefined, ...levels].flatMap(level => {
    const variant = variants.find(m => m.effort === level);
    return variant ? [option(variant.id, level ?? '默认强度')] : [];
  }) : [];
  return { models, efforts, effortField: 'models', effortValue: target.model ?? '', storedEffort: effortInId(target.model) };
}
