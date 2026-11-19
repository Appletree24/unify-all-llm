import type { Config } from '../core/config.js';
import { officialApis, readApiProfile, type ApiProfile, type OfficialApi } from '../providers/official.js';
import { modelIds } from '../providers/models.js';
import type { Key } from './keys.js';
import { rgb, Screen } from './screen.js';

const gold = rgb(232, 196, 104);
const dim = rgb(120, 125, 135);

export class ApiView {
  private index = 0;
  private step: 'provider' | 'model' | 'key' = 'provider';
  private profile?: ApiProfile;
  private input = '';
  private models: string[] = [];
  private modelIndex = 0;
  private error = '';

  constructor(
    private cfg: Config,
    private save: (api: OfficialApi, profile: ApiProfile) => void,
    private close: () => void,
  ) {}

  handleKey(k: Key): void {
    if (k.name === 'esc' || k.name === 'ctrl+c') return this.close();
    const api = officialApis[this.index];
    this.error = '';
    try {
      if (this.step === 'provider') {
        if (k.name === 'up') this.index = (this.index + officialApis.length - 1) % officialApis.length;
        if (k.name === 'down') this.index = (this.index + 1) % officialApis.length;
        if (k.name !== 'enter') return;
        if (this.cfg.custom?.[api.id] || this.cfg.targets?.[api.id]) throw new Error(`目标 ${api.id} 已由现有配置使用`);
        this.profile = readApiProfile(api);
        this.models = modelIds(api.id, [this.profile?.model ?? api.model]);
        this.modelIndex = 0;
        this.step = 'model';
      } else if (this.step === 'model') {
        if (k.name === 'up') this.modelIndex = (this.modelIndex + this.models.length - 1) % this.models.length;
        if (k.name === 'down') this.modelIndex = (this.modelIndex + 1) % this.models.length;
        if (k.name === 'enter') this.step = 'key';
      } else if (k.name === 'enter') {
        const apiKey = this.input.trim() || this.profile?.apiKey;
        if (!apiKey && !process.env[api.apiKeyEnv]) throw new Error('请输入 API Key');
        this.save(api, { model: this.models[this.modelIndex], ...(apiKey ? { apiKey } : {}) });
        this.close();
      } else if (k.name === 'char' || k.name === 'paste') {
        this.input += k.text ?? '';
      } else if (k.name === 'backspace') this.input = this.input.slice(0, -1);
      else if (k.name === 'ctrl+u') this.input = '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : '保存失败';
    }
  }

  draw(s: Screen): void {
    s.put(1, 0, '接入官方 API', `1;${gold}`);
    const api = officialApis[this.index];
    if (this.step === 'provider') {
      s.put(1, 2, '选择服务商', dim);
      officialApis.forEach((item, i) => {
        s.put(1, 3 + i, `${this.index === i ? '›' : ' '} ${item.label}`, this.index === i ? gold : '');
      });
      s.put(1, s.rows - 1, '↑↓ 选择  Enter 继续  Esc 返回', dim);
    } else {
      s.put(1, 1, api.label, gold);
      s.put(1, 2, api.baseUrl, dim);
      if (this.step === 'model') {
        const override = this.cfg.models?.[api.id];
        s.put(1, 3, override ? `当前项目使用 ${override}，请选择 API 默认模型` : '选择默认模型', dim);
        const room = s.rows - 7;
        const first = Math.max(0, this.modelIndex - room + 1);
        this.models.slice(first, first + room).forEach((model, row) => {
          const selected = row + first === this.modelIndex;
          s.put(1, 4 + row, `${selected ? '›' : ' '} ${model}`, selected ? gold : '');
        });
        s.put(1, s.rows - 1, '↑↓ 选择  Enter 继续  Esc 取消', dim);
      } else {
        s.put(1, 3, this.cfg.models?.[api.id] ?? this.models[this.modelIndex]);
        s.put(1, 5, 'API Key');
        const hint = this.profile?.apiKey ? '留空沿用已保存的密钥' : process.env[api.apiKeyEnv] ? `留空使用 ${api.apiKeyEnv}` : '粘贴密钥';
        s.put(1, 6, this.input ? '•'.repeat(Math.min(32, this.input.length)) : hint, this.input ? '' : dim);
        s.put(1, 8, '输入的密钥将保存到 ~/.unify/api/', dim);
        s.put(1, s.rows - 1, 'Enter 保存并选用  Esc 取消', dim);
      }
    }
    if (this.error) s.put(1, s.rows - 2, this.error, rgb(240, 90, 90));
  }
}
