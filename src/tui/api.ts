import type { Config } from '../core/config.js';
import { officialApis, readApiProfile, type ApiProfile, type OfficialApi } from '../providers/official.js';
import { modelIds } from '../providers/models.js';
import type { Key } from './keys.js';
import { rgb, Screen, textWidth, toCells, truncate } from './screen.js';
import { wrap } from './markdown.js';

const GOLD = rgb(232, 196, 104);
const TEAL = rgb(25, 195, 155);
const VIOLET = rgb(190, 140, 255);
const RED = rgb(240, 90, 90);
const DIM = rgb(120, 125, 135);
const BORDER = rgb(72, 76, 86);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function safeProfile(api: OfficialApi): ApiProfile | undefined {
  try { return readApiProfile(api); } catch { return undefined; }
}

function drawBox(s: Screen, x: number, y: number, w: number, h: number, title: string, borderSt: string, titleSt: string): void {
  if (w < 4 || h < 2) return;
  const right = x + w - 1;
  const bottom = y + h - 1;
  s.put(x, y, '╭' + '─'.repeat(w - 2) + '╮', borderSt);
  s.put(x, bottom, '╰' + '─'.repeat(w - 2) + '╯', borderSt);
  for (let row = y + 1; row < bottom; row++) {
    s.put(x, row, '│', borderSt);
    s.put(right, row, '│', borderSt);
  }
  if (title && w > 6) s.put(x + 2, y, ` ${truncate(title, w - 6)} `, titleSt, right);
}

function drawHints(s: Screen, y: number, hints: string[]): void {
  let x = 1;
  for (const h of hints) {
    if (x + textWidth(h) + 3 > s.cols) break;
    const [key, ...rest] = h.split(' ');
    x = s.put(x, y, key, '');
    x = s.put(x, y, ' ' + rest.join(' '), DIM) + 3;
  }
}

export class ApiView {
  private index = 0;
  private step: 'provider' | 'model' | 'key' = 'provider';
  private profile?: ApiProfile;
  private input = '';
  private models: string[] = [];
  private modelIndex = 0;
  private error = '';
  private hit?: { x: number; y: number; w: number; first: number; count: number };

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
        if (k.name === 'up' || k.name === 'wheelup') this.index = (this.index + officialApis.length - 1) % officialApis.length;
        else if (k.name === 'down' || k.name === 'wheeldown') this.index = (this.index + 1) % officialApis.length;
        else if (k.name === 'click' && k.x !== undefined && k.y !== undefined && this.hit) {
          const { x, y, w, first, count } = this.hit;
          if (k.x >= x && k.x < x + w && k.y >= y && k.y < y + count) {
            this.index = first + (k.y - y);
            this.enterProvider(officialApis[this.index]);
          }
          return;
        }
        if (k.name !== 'enter') return;
        this.enterProvider(api);
      } else if (this.step === 'model') {
        if (k.name === 'up' || k.name === 'wheelup') this.modelIndex = (this.modelIndex + this.models.length - 1) % this.models.length;
        else if (k.name === 'down' || k.name === 'wheeldown') this.modelIndex = (this.modelIndex + 1) % this.models.length;
        else if (k.name === 'click' && k.x !== undefined && k.y !== undefined && this.hit) {
          const { x, y, w, first, count } = this.hit;
          if (k.x >= x && k.x < x + w && k.y >= y && k.y < y + count) {
            this.modelIndex = first + (k.y - y);
            this.step = 'key';
          }
          return;
        }
        else if (k.name === 'enter') this.step = 'key';
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

  private enterProvider(api: OfficialApi): void {
    if (this.cfg.custom?.[api.id] || this.cfg.targets?.[api.id]) throw new Error(`目标 ${api.id} 已由现有配置使用`);
    this.profile = readApiProfile(api);
    this.models = modelIds(api.id, [this.profile?.model ?? api.model]);
    this.modelIndex = 0;
    this.step = 'model';
  }

  draw(s: Screen): void {
    this.hit = undefined;
    const api = officialApis[this.index];

    // ── Header Bar ────────────────────────────────────────────────────────
    let hx = s.put(1, 0, '✦ unify', `1;${GOLD}`) + 2;
    hx = s.put(hx, 0, '设置', DIM);
    hx = s.put(hx, 0, ' › ', DIM);
    hx = s.put(hx, 0, '接入官方 API', `1;${GOLD}`);

    const steps: [string, 'provider' | 'model' | 'key'][] = [
      ['① 服务商', 'provider'],
      ['② 模型', 'model'],
      ['③ 密钥', 'key'],
    ];
    const activeIdx = steps.findIndex(([, k]) => k === this.step);
    const stepText = steps.map(([label]) => label).join(' › ');
    if (s.cols - textWidth(stepText) - 2 > hx) {
      let sx = s.cols - textWidth(stepText) - 1;
      steps.forEach(([label], i) => {
        if (i > 0) sx = s.put(sx, 0, ' › ', DIM);
        sx = s.put(sx, 0, label, i === activeIdx ? `1;${GOLD}` : i < activeIdx ? TEAL : DIM);
      });
    }

    const subtitle = this.step === 'provider'
      ? '直接接入官方 API 服务商，保存后立即选用并支持直接提问'
      : this.step === 'model'
        ? `${api.label} · ${this.cfg.models?.[api.id] ? `当前项目覆盖为 ${this.cfg.models[api.id]}，选择 API 默认模型` : '选择默认模型'}`
        : `${api.label} · ${this.cfg.models?.[api.id] ?? this.models[this.modelIndex]} · 密钥仅保存在本机用户目录`;
    s.put(1, 1, truncate(subtitle, s.cols - 2), DIM);
    s.put(0, 2, '─'.repeat(s.cols), BORDER);

    const top = 3;
    const bodyH = Math.max(3, s.rows - 5);
    const wide = s.cols >= 76;
    const leftW = wide ? clamp(Math.floor(s.cols * 0.54), 36, 66) : s.cols - 2;
    const rightX = leftW + 2;
    const rightW = s.cols - rightX - 1;

    if (this.step === 'provider') {
      drawBox(s, 1, top, leftW, bodyH, '选择服务商', GOLD, `1;${GOLD}`);
      const room = Math.max(1, bodyH - 2);
      const count = Math.min(room, officialApis.length);
      this.hit = { x: 2, y: top + 1, w: leftW - 2, first: 0, count };
      officialApis.slice(0, room).forEach((item, i) => {
        const y = top + 1 + i;
        const on = this.index === i;
        const profile = safeProfile(item);
        const hasEnv = !!process.env[item.apiKeyEnv];
        const badge = profile?.apiKey ? '● 已配置' : hasEnv ? '● 环境变量' : '○ 未配置';
        const badgeSt = profile?.apiKey || hasEnv ? TEAL : DIM;
        const bw = textWidth(badge);
        s.put(3, y, on ? '›' : ' ', on ? `1;${GOLD}` : '');
        s.put(5, y, truncate(item.label, Math.max(4, leftW - 8 - bw)), on ? `1;${GOLD}` : '');
        s.put(leftW - 1 - bw, y, badge, badgeSt, leftW);
      });
    } else if (this.step === 'model') {
      drawBox(s, 1, top, leftW, bodyH, `${api.label} · 选择模型`, GOLD, `1;${GOLD}`);
      const room = Math.max(1, bodyH - 2);
      const first = Math.max(0, this.modelIndex - room + 1);
      const count = Math.min(room, this.models.length - first);
      this.hit = { x: 2, y: top + 1, w: leftW - 2, first, count };
      const savedModel = this.profile?.model;
      this.models.slice(first, first + room).forEach((model, row) => {
        const y = top + 1 + row;
        const on = row + first === this.modelIndex;
        const badge = model === savedModel ? '● 已保存' : '';
        const bw = textWidth(badge);
        s.put(3, y, on ? '›' : ' ', on ? `1;${GOLD}` : '');
        s.put(5, y, truncate(model, Math.max(4, leftW - 8 - bw)), on ? `1;${GOLD}` : '');
        if (badge) s.put(leftW - 1 - bw, y, badge, TEAL, leftW);
      });
      if (this.models.length > room) {
        const thumbH = Math.max(1, Math.round((room * room) / this.models.length));
        const thumbY = Math.round(((room - thumbH) * first) / Math.max(1, this.models.length - room));
        for (let i = 0; i < thumbH; i++) s.put(leftW, top + 1 + thumbY + i, '┃', GOLD);
      }
    } else {
      const boxW = wide ? leftW : s.cols - 2;
      drawBox(s, 1, top, boxW, bodyH, `${api.label} · 配置 API Key`, GOLD, `1;${GOLD}`);
      const ix = 4;
      const iw = Math.max(8, boxW - 6);
      let cy = top + 1;
      if (cy < top + bodyH - 1) {
        s.put(ix, cy, '已选模型  ', DIM);
        s.put(ix + 10, cy, truncate(this.cfg.models?.[api.id] ?? this.models[this.modelIndex], iw - 10), `1;${GOLD}`);
        cy += 2;
      }
      if (cy < top + bodyH - 1) {
        s.put(ix, cy++, 'API Key', '1');
      }
      const hint = this.profile?.apiKey ? '留空沿用已保存的密钥' : process.env[api.apiKeyEnv] ? `留空使用 ${api.apiKeyEnv}` : '粘贴密钥';
      const masked = this.input ? '•'.repeat(Math.min(Math.max(4, iw - 6), this.input.length)) : '';
      if (cy + 2 < top + bodyH - 1) {
        drawBox(s, ix, cy, iw, 3, '', GOLD, '');
        if (masked) {
          const endX = s.put(ix + 2, cy + 1, masked, '', ix + iw - 2);
          s.put(endX, cy + 1, '▏', `1;${GOLD}`, ix + iw - 1);
        } else {
          s.put(ix + 2, cy + 1, truncate(hint, iw - 4), DIM, ix + iw - 2);
        }
        cy += 4;
      } else if (cy < top + bodyH - 1) {
        s.put(ix, cy++, masked || truncate(hint, iw), masked ? '' : DIM, ix + iw);
      }
      if (cy < top + bodyH - 1) {
        const note = wrap(toCells('输入的密钥将以 0600 权限保存到 ~/.unify/api/，不会写入聊天记录。', DIM), iw);
        note.slice(0, top + bodyH - 1 - cy).forEach((line, i) => s.putCells(ix, cy + i, line, ix + iw));
      }
    }

    if (wide && rightW >= 20) {
      this.drawDetail(s, rightX, top, rightW, bodyH, api);
    }

    if (this.error) s.put(1, s.rows - 2, truncate(`✗ ${this.error}`, s.cols - 2), RED);
    else {
      const dotX = s.put(1, s.rows - 2, '● ', VIOLET);
      s.put(dotX, s.rows - 2, truncate(`存储位置 → ~/.unify/api/${api.id}.json（用户私有配置）`, s.cols - 4), DIM);
    }

    const hints = this.step === 'key'
      ? ['Enter 保存并选用', 'Ctrl+U 清空', 'Esc 取消']
      : ['↑↓ 选择', 'Enter 继续', this.step === 'provider' ? 'Esc 返回' : 'Esc 取消'];
    drawHints(s, s.rows - 1, hints);
  }

  private drawDetail(s: Screen, x: number, y: number, w: number, h: number, api: OfficialApi): void {
    drawBox(s, x, y, w, h, api.label, BORDER, '1');
    const ix = x + 2;
    const iw = Math.max(8, w - 4);
    const maxY = y + h - 1;
    let cy = y + 1;

    const profile = this.step === 'provider' ? safeProfile(api) : this.profile;
    const hasEnv = !!process.env[api.apiKeyEnv];
    const dotX = s.put(ix, cy, '● ', VIOLET, ix + iw);
    s.put(dotX, cy, truncate(`用户配置 · ~/.unify/api/${api.id}.json`, iw - 2), DIM, ix + iw);
    cy += 2;

    const rows: [string, string, string][] = [
      ['目标 ID', api.id, GOLD],
      ['接口地址', api.baseUrl, DIM],
      ['环境变量', api.apiKeyEnv + (hasEnv ? '（已检测到）' : ''), hasEnv ? TEAL : DIM],
      ['默认模型', profile?.model ?? api.model, ''],
      ['密钥状态', profile?.apiKey ? '已保存本地密钥' : hasEnv ? '使用环境变量' : '尚未配置', profile?.apiKey || hasEnv ? TEAL : DIM],
    ];
    for (const [label, value, st] of rows) {
      if (cy >= maxY) break;
      s.put(ix, cy, label, DIM, ix + 10);
      s.put(ix + 10, cy, truncate(value, Math.max(4, iw - 10)), st, ix + iw);
      cy++;
    }
    cy++;
    if (cy < maxY) {
      const note = '配置保存后当前会话将立即选用该服务商，后续可在「设置 → 回答、汇总与执行」中组合多个模型并排对比。';
      const lines = wrap(toCells(note, DIM), iw);
      lines.slice(0, maxY - cy).forEach((line, i) => s.putCells(ix, cy + i, line, ix + iw));
    }
  }
}
