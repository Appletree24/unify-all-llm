import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, readJson, type Config } from '../core/config.js';
import { userField, writeSetting, type SettingField } from '../core/settings.js';
import type { ModelTarget } from '../core/types.js';
import type { ModelTests } from '../core/model-tests.js';
import { targetModelIds } from '../providers/models.js';
import { effortChoices } from '../providers/effort.js';
import { Editor } from './editor.js';
import type { Key } from './keys.js';
import { Screen, rgb, truncate, textWidth, toCells } from './screen.js';
import { wrap } from './markdown.js';

type Field = SettingField;
const gold = rgb(232, 196, 104);
const dim = rgb(120, 125, 135);

export { writeSetting };

interface SettingsState {
  cfg: Config;
  targets: ModelTarget[];
  selected: string[];
  showReasoning: boolean;
  mouse: boolean;
}

interface Row { label: string; value?: string; detail?: string; open(): void }
interface Page { title: string; rows(): Row[]; index: number }
interface Input { title: string; hint: string; editor: Editor; save(value: string): void }

export class SettingsView {
  private pages: Page[];
  private input?: Input;
  private message = '';
  private visible?: { page: Page; first: number; count: number };

  constructor(
    private cwd: string,
    private tests: ModelTests,
    private state: () => SettingsState,
    private save: (field: Field, value: unknown, entry?: string) => void,
    private api: () => void,
    private close: () => void,
  ) {
    this.pages = [{ title: '设置', rows: () => this.main(), index: 0 }];
  }

  private page(title: string, rows: () => Row[], index = 0): void {
    this.pages.push({ title, rows, index });
  }

  private edit(title: string, initial: string, hint: string, save: Input['save']): void {
    const editor = new Editor();
    editor.set(initial);
    this.input = { title, hint, editor, save };
  }

  private main(): Row[] {
    const state = this.state();
    return [
      { label: '官方 API 接入', open: this.api },
      { label: '模型与思考强度', open: () => this.page('模型与思考强度', () => this.targetRows()) },
      { label: '回答、汇总与执行', value: state.selected.join(', '), open: () => this.page('回答、汇总与执行', () => this.routing()) },
      { label: '并发与超时', open: () => this.page('并发与超时', () => this.limits()) },
      { label: '显示思考过程', value: state.showReasoning ? '开' : '关', open: () => this.save('showReasoning', !state.showReasoning) },
      { label: '鼠标滚动', value: state.mouse ? '开' : '关', open: () => this.save('mouse', !state.mouse) },
      { label: '高级配置', open: () => this.page('高级配置', () => this.advanced()) },
    ];
  }

  private targetRows(): Row[] {
    return this.state().targets.map(t => ({
      label: t.id, value: t.reasoningEffort ?? '默认',
      open: () => this.page(t.id, () => this.targetOptions(t.id)),
    }));
  }

  private targetOptions(id: string): Row[] {
    const { targets } = this.state();
    const target = targets.find(t => t.id === id)!;
    const config = target.adapter.configuration;
    const model = target.model ?? (config?.type === 'openai' ? config.model : '默认');
    const choices = effortChoices(target);
    const test = this.tests.state(target);
    return [
      {
        label: '模型 ID', value: model,
        open: () => {
          const ids = [undefined, ...targetModelIds(target, targets)];
          const selected = Math.max(0, ids.indexOf(target.model));
          this.page(id + ' · 选择模型', () => ids.map((choice, index) => ({
            label: choice ?? '继承配置',
            value: index === selected ? '●' : '',
            open: () => { this.save('models', choice, id); this.pages.pop(); },
          })), selected);
        },
      },
      {
        label: '思考强度', value: choices.length ? target.reasoningEffort ?? '默认' : '此接口不支持',
        open: () => {
          if (!choices.length) {
            this.message = target.adapter.id === 'gemini' ? '可从已配置的模型中选择 Gemini CLI 思考别名' : '此模型或接口未提供可配置的思考档位';
            return;
          }
          this.page('思考强度 · ' + id, () => ['default', ...choices].map(level => ({
            label: level === 'default' ? '默认（由模型决定）' : level,
            value: level === (target.reasoningEffort ?? 'default') ? '●' : '',
            open: () => { this.save('reasoningEffort', level, id); this.pages.pop(); },
          })));
        },
      },
      {
        label: '测试可用性', value: test?.status === 'failed' ? '测试失败' : test?.message,
        detail: test?.status === 'failed' ? test.message : undefined,
        open: () => { void this.tests.run(target, this.state().cfg.timeoutSec); },
      },
    ];
  }

  private routing(): Row[] {
    const { cfg, targets } = this.state();
    const rows: Row[] = [{
      label: '默认回答目标', value: cfg.providers?.join(', ') ?? '自动',
      open: () => this.edit('默认回答目标', cfg.providers?.join(',') ?? '', '逗号分隔，留空自动选择。可选 ' + targets.map(t => t.id).join(', '),
        v => this.save('providers', v ? v.split(/[,，\s]+/) : undefined)),
    }];
    for (const [key, label] of [['synthesizer', '汇总模型'], ['executor', '执行模型'], ['decider', '决策模型']] as const) {
      rows.push({ label, value: cfg[key] ?? '默认', open: () => this.page(label, () =>
        [undefined, ...targets.filter(t => key !== 'executor' || t.adapter.capabilities.exec).map(t => t.id)].map(id => ({
          label: id ?? '恢复默认', open: () => { this.save(key, id); this.pages.pop(); },
        }))) });
    }
    return rows;
  }

  private limits(): Row[] {
    return ([['concurrency', '回答并发数', 3], ['timeoutSec', '回答与汇总超时（秒）', 600],
      ['decisionTimeoutSec', '决策超时（秒）', 60], ['execTimeoutSec', '执行超时（秒）', 3600]] as const).map(([key, label, fallback]) => ({
      label, value: String(this.state().cfg[key] ?? fallback),
      open: () => this.edit(label, String(this.state().cfg[key] ?? fallback), '留空恢复默认', v => this.save(key, v ? Number(v) : undefined)),
    }));
  }

  private advanced(): Row[] {
    const { cfg } = this.state();
    const rows: Row[] = [{ label: '禁用 Claude Code', value: cfg.disableClaude ? '开' : '关', open: () => this.save('disableClaude', !cfg.disableClaude) }];
    for (const [key, label] of [['targets', '目标别名'], ['custom', '自定义端点与命令'], ['quotaCommands', '额度查询命令']] as const) {
      rows.push({ label, value: userField(key) ? '用户配置' : '项目配置', open: () => {
        const path = userField(key) ? join(homedir(), '.unify', 'config.json') : join(this.cwd, 'unify.config.json');
        const layer = parseConfig(readJson(path) ?? {}, path);
        this.edit(label, JSON.stringify(layer[key] ?? {}), '编辑 JSON 对象，可粘贴完整内容。Ctrl+U 清空', v => this.save(key, v ? JSON.parse(v) : undefined));
      } });
    }
    return rows;
  }

  handleKey(k: Key): void {
    this.message = '';
    if (k.name === 'esc' || k.name === 'ctrl+c') {
      if (this.input) this.input = undefined;
      else if (this.pages.length > 1) this.pages.pop();
      else this.close();
      return;
    }
    try {
      if (this.input) {
        const { editor, save } = this.input;
        switch (k.name) {
          case 'enter': save(editor.text.trim()); this.input = undefined; this.message = '已保存'; break;
          case 'char': case 'paste': editor.insert((k.text ?? '').replace(/[\r\n]/g, ' ')); break;
          case 'ctrl+u': editor.clear(); break;
          case 'backspace': editor.backspace(); break;
          case 'delete': editor.del(); break;
          case 'left': editor.left(); break;
          case 'right': editor.right(); break;
          case 'home': case 'ctrl+a': editor.home(); break;
          case 'end': case 'ctrl+e': editor.end(); break;
        }
        return;
      }
      const page = this.pages[this.pages.length - 1];
      const rows = page.rows();
      if (!rows.length) return;
      if (k.name === 'down') page.index = (page.index + 1) % rows.length;
      if (k.name === 'up') page.index = (page.index + rows.length - 1) % rows.length;
      if (k.name === 'enter') rows[page.index]?.open();
      if (k.name === 'click' && k.y !== undefined && this.visible?.page === page) {
        const offset = k.y - 2;
        if (offset >= 0 && offset < this.visible.count) {
          page.index = this.visible.first + offset;
          rows[page.index]?.open();
        }
      }
    } catch (err) { this.message = err instanceof Error ? err.message : String(err); }
  }

  draw(s: Screen): void {
    const page = this.pages[this.pages.length - 1];
    s.put(1, 0, this.pages.map(p => p.title).join(' › '), gold);
    if (this.input) {
      const { title, hint, editor } = this.input;
      s.put(2, 2, title, '1');
      let left = editor.chars.slice(0, editor.caret).join('');
      const window = s.cols - 6;
      if (textWidth(left) > window) left = '…' + Array.from(left).slice(-Math.floor(window / 2)).join('');
      s.put(2, 4, left + '▏' + editor.chars.slice(editor.caret).join(''));
      s.put(2, 6, hint, dim);
    } else {
      const rows = page.rows();
      const room = s.rows - 6;
      const first = Math.max(0, page.index - room + 1);
      this.visible = { page, first, count: Math.min(room, rows.length - first) };
      rows.slice(first, first + room).forEach((r, i) => {
        const on = i + first === page.index;
        s.put(1, 2 + i, truncate(`${on ? '›' : ' '} ${r.label}${r.value ? '   ' + r.value : ''}`, s.cols - 2), on ? gold : '');
      });
      const detail = rows[page.index]?.detail;
      if (detail) {
        const top = 3 + rows.length - first;
        const lines = wrap(toCells(detail.replace(/\s+/g, ' ')), s.cols - 4);
        lines.slice(0, Math.max(0, s.rows - top - 3)).forEach((line, i) => s.putCells(2, top + i, line));
      }
    }
    s.put(1, s.rows - 3, this.message, gold);
    s.put(1, s.rows - 2, '项目设置保存到 ./unify.config.json；API 凭证与命令属于用户配置', dim);
    s.put(1, s.rows - 1, this.input ? 'Enter 保存  Ctrl+U 清空  Esc 取消' : '↑↓ 选择  Enter 设置  Esc 返回', dim);
  }
}
