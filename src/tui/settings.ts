import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseConfig, readJson, type Config } from '../core/config.js';
import { projectConfigPath, userField, writeSetting, type SettingField } from '../core/settings.js';
import type { ModelTarget } from '../core/types.js';
import type { ModelTests } from '../core/model-tests.js';
import { isAgyProvider, modelSettings, type AgyModel } from '../providers/agy-models.js';
import { readAgyModels, targetModelIds } from '../providers/models.js';
import { officialApis, readApiProfile } from '../providers/official.js';
import { effortChoices } from '../providers/effort.js';
import { Editor } from './editor.js';
import type { Key } from './keys.js';
import { Screen, rgb, truncate, textWidth, toCells } from './screen.js';
import { wrap } from './markdown.js';

type Field = SettingField;

const GOLD = rgb(232, 196, 104);
const TEAL = rgb(25, 195, 155);
const VIOLET = rgb(190, 140, 255);
const YELLOW = rgb(235, 190, 90);
const RED = rgb(240, 90, 90);
const DIM = rgb(120, 125, 135);
const BORDER = rgb(72, 76, 86);

const PROVIDER_COLORS: Record<string, string> = {
  claude: rgb(217, 119, 87),
  anthropic: rgb(217, 119, 87),
  codex: TEAL,
  deepseek: rgb(110, 130, 250),
  'gemini-pro': VIOLET,
  'gemini-api': VIOLET,
  openai: rgb(120, 200, 230),
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export { writeSetting };

interface SettingsState {
  cfg: Config;
  targets: ModelTarget[];
  selected: string[];
  showReasoning: boolean;
  mouse: boolean;
}

interface PreviewLine {
  label?: string;
  text: string;
  style?: string;
}

interface Row {
  label: string;
  value?: string;
  valueStyle?: string;
  accent?: string;
  chevron?: boolean;
  scope?: 'project' | 'user' | 'action';
  scopeText?: string;
  summary?: string;
  detail?: string;
  preview?: () => PreviewLine[];
  open(): void;
}

interface Page {
  title: string;
  subtitle: string;
  rows(): Row[];
  index: number;
  confirm?(): void;
}

interface Input {
  title: string;
  hint: string;
  scope: 'project' | 'user';
  editor: Editor;
  save(value: string): void;
}

function targetColor(target: ModelTarget): string {
  return PROVIDER_COLORS[target.id] ?? PROVIDER_COLORS[target.adapter.id] ?? rgb(230, 130, 180);
}

function safeApiProfile(api: typeof officialApis[number]) {
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

export class SettingsView {
  private pages: Page[];
  private input?: Input;
  private message = '';
  private messageKind: 'ok' | 'err' | 'info' = 'info';
  private agyCatalog?: AgyModel[];
  private agyLoading = false;
  private agyError = '';
  private hit?: { page: Page; x: number; y: number; w: number; first: number; count: number };

  constructor(
    private cwd: string,
    private tests: ModelTests,
    private state: () => SettingsState,
    private save: (field: Field, value: unknown, entry?: string) => void,
    private api: () => void,
    private close: () => void,
    private redraw: () => void,
  ) {
    this.pages = [{
      title: '设置',
      subtitle: '调整模型、路由、并发与界面偏好 · 改动立即生效并自动保存',
      rows: () => this.main(),
      index: 0,
    }];
  }

  private page(title: string, subtitle: string, rows: () => Row[], index = 0): void {
    this.pages.push({ title, subtitle, rows, index });
  }

  private edit(title: string, initial: string, hint: string, scope: 'project' | 'user', save: Input['save']): void {
    const editor = new Editor();
    editor.set(initial);
    this.input = { title, hint, scope, editor, save };
  }

  private main(): Row[] {
    const state = this.state();
    const { cfg, targets } = state;
    const apiStatuses = officialApis.map(api => {
      const profile = safeApiProfile(api);
      const hasEnv = !!process.env[api.apiKeyEnv];
      return { api, profile, hasEnv, active: !!profile?.apiKey || hasEnv };
    });
    const configuredApis = apiStatuses.filter(a => a.active).length;
    const advancedCount = (cfg.disableClaude ? 1 : 0)
      + Object.keys(cfg.targets ?? {}).length
      + Object.keys(cfg.custom ?? {}).length
      + Object.keys(cfg.quotaCommands ?? {}).length;

    return [
      {
        label: '官方 API 接入',
        value: configuredApis ? `${configuredApis}/${officialApis.length} 已接入` : '未配置',
        valueStyle: configuredApis ? TEAL : DIM,
        chevron: true,
        scope: 'user',
        scopeText: '用户配置 · ~/.unify/api/',
        summary: '直接接入 DeepSeek、OpenAI、Anthropic 或 Gemini 官方 API，无需安装外部 CLI。',
        preview: () => apiStatuses.map(({ api, profile, hasEnv }) => ({
          label: api.label,
          text: profile?.apiKey ? `已保存密钥 · ${profile.model}` : hasEnv ? `环境变量 ${api.apiKeyEnv}` : '未配置',
          style: profile?.apiKey || hasEnv ? TEAL : DIM,
        })),
        open: this.api,
      },
      {
        label: '模型与思考强度',
        value: `${targets.length} 个目标`,
        valueStyle: DIM,
        chevron: true,
        scope: 'project',
        summary: '为每个目标单独指定模型与思考档位，并可即时测试连通性与可用性。',
        preview: () => targets.slice(0, 8).map(t => ({
          label: t.id,
          text: [t.model ?? '默认模型', t.reasoningEffort ? `思考 ${t.reasoningEffort}` : ''].filter(Boolean).join(' · '),
          style: targetColor(t),
        })),
        open: () => this.page('模型与思考强度', '选择目标以覆盖模型、思考强度或运行即时可用性测试', () => this.targetRows()),
      },
      {
        label: '回答、汇总与执行',
        value: state.selected.join(', ') || '自动',
        valueStyle: state.selected.length ? GOLD : DIM,
        chevron: true,
        scope: 'project',
        summary: '配置每次问答默认调用的目标列表，以及汇总、实施和决策模型。',
        preview: () => [
          { label: '回答目标', text: cfg.providers?.join(', ') ?? (state.selected.length ? `自动（${state.selected.join(', ')}）` : '自动'), style: GOLD },
          { label: '汇总模型', text: cfg.synthesizer ?? '默认', style: cfg.synthesizer ? '' : DIM },
          { label: '执行模型', text: cfg.executor ?? '默认', style: cfg.executor ? '' : DIM },
          { label: '决策模型', text: cfg.decider ?? '不使用', style: cfg.decider ? '' : DIM },
        ],
        open: () => this.page('回答、汇总与执行', '配置默认回答目标，以及汇总、执行与决策所用的模型', () => this.routing()),
      },
      {
        label: '并发与超时',
        value: `${cfg.concurrency ?? 3} 并发 · ${cfg.timeoutSec ?? 600}s`,
        valueStyle: DIM,
        chevron: true,
        scope: 'project',
        summary: '控制同时运行的模型数量，以及回答、汇总、决策和实施的超时上限。',
        preview: () => [
          { label: '回答并发数', text: `${cfg.concurrency ?? 3} 个目标同时运行` },
          { label: '回答与汇总超时', text: `${cfg.timeoutSec ?? 600} 秒` },
          { label: '决策超时', text: `${cfg.decisionTimeoutSec ?? 60} 秒` },
          { label: '执行超时', text: `${cfg.execTimeoutSec ?? 3600} 秒` },
        ],
        open: () => this.page('并发与超时', '按需调整并发上限和各阶段超时，留空可恢复默认值', () => this.limits()),
      },
      {
        label: '显示思考过程',
        value: state.showReasoning ? '● 开' : '○ 关',
        valueStyle: state.showReasoning ? TEAL : DIM,
        scope: 'project',
        summary: '控制界面启动时是否默认展开模型的思考过程。在主界面按 Ctrl+R 可临时切换。',
        preview: () => [
          { label: '当前状态', text: state.showReasoning ? '默认展开思考过程' : '默认隐藏思考过程', style: state.showReasoning ? TEAL : DIM },
          { label: '快捷键', text: 'Ctrl+R（主界面临时切换）', style: DIM },
        ],
        open: () => this.save('showReasoning', !state.showReasoning),
      },
      {
        label: '鼠标滚动',
        value: state.mouse ? '● 开' : '○ 关',
        valueStyle: state.mouse ? TEAL : DIM,
        scope: 'project',
        summary: '开启后支持滚轮翻页、面板内拖选复制和点击文件路径预览；关闭后使用终端原生选区。',
        preview: () => [
          { label: '当前状态', text: state.mouse ? '已开启 TUI 鼠标交互' : '已关闭（使用终端原生选区）', style: state.mouse ? TEAL : DIM },
          { label: '包含能力', text: '滚轮滚动 · 拖选复制 · 路径跳转', style: DIM },
        ],
        open: () => this.save('mouse', !state.mouse),
      },
      {
        label: '高级配置',
        value: advancedCount ? `${advancedCount} 项已配置` : '默认',
        valueStyle: advancedCount ? VIOLET : DIM,
        chevron: true,
        scope: 'user',
        summary: '管理目标别名、自定义 OpenAI 端点/命令、额度查询脚本及全局禁用 Claude Code。',
        preview: () => [
          { label: '禁用 Claude', text: cfg.disableClaude ? '已全局禁用' : '未禁用', style: cfg.disableClaude ? YELLOW : DIM },
          { label: '目标别名', text: `${Object.keys(cfg.targets ?? {}).length} 项（项目配置）`, style: DIM },
          { label: '自定义端点', text: `${Object.keys(cfg.custom ?? {}).length} 项（用户配置）`, style: DIM },
          { label: '额度命令', text: `${Object.keys(cfg.quotaCommands ?? {}).length} 项（用户配置）`, style: DIM },
        ],
        open: () => this.page('高级配置', '编辑别名、自定义协议端点、额度命令及全局开关', () => this.advanced()),
      },
    ];
  }

  private targetRows(): Row[] {
    const { targets } = this.state();
    return targets.map(t => {
      const agy = isAgyProvider(t.adapter.id, t.adapter.capabilities.askPolicy);
      const test = this.tests.state(t);
      const val = agy ? (t.model ?? '默认') : (t.reasoningEffort ?? '默认');
      return {
        label: t.id,
        value: val,
        valueStyle: targetColor(t),
        accent: targetColor(t),
        chevron: true,
        scope: 'project',
        summary: `配置 ${t.label}（${t.id}）所使用的模型与思考档位，或发送一次简短提问测试可用性。`,
        preview: () => [
          { label: '目标 ID', text: t.id, style: targetColor(t) },
          { label: '适配器', text: t.adapter.id },
          { label: '当前模型', text: t.model ?? '默认' },
          { label: '思考强度', text: t.reasoningEffort ?? '默认' },
          { label: '能力', text: t.adapter.capabilities.exec ? '问答 · 支持实施' : '仅问答', style: DIM },
          ...(test ? [{
            label: '最近测试',
            text: test.status === 'failed' ? `测试失败 · ${test.message}` : test.message,
            style: test.status === 'failed' ? RED : test.status === 'passed' ? TEAL : YELLOW,
          }] : []),
        ],
        open: () => {
          if (agy) void this.loadAgyCatalog();
          const models = targetModelIds(t, targets);
          this.page(t.id, `${t.label} · 选择模型、调整思考强度或测试连通性`, () => this.targetOptions(t.id, models));
        },
      };
    });
  }

  private async loadAgyCatalog(): Promise<void> {
    if (this.agyLoading || this.agyCatalog) return;
    this.agyLoading = true;
    this.agyError = '';
    try { this.agyCatalog = await readAgyModels(this.cwd); }
    catch (err) { this.agyError = err instanceof Error ? err.message : String(err); }
    finally { this.agyLoading = false; this.redraw(); }
  }

  private targetOptions(id: string, models: string[]): Row[] {
    const { targets } = this.state();
    const target = targets.find(t => t.id === id)!;
    const config = target.adapter.configuration;
    const model = target.model ?? (config?.type === 'openai' ? config.model : undefined);
    const agy = isAgyProvider(target.adapter.id, target.adapter.capabilities.askPolicy);
    const options = modelSettings({
      model, models, efforts: effortChoices(target), reasoningEffort: target.reasoningEffort,
    }, agy ? this.agyCatalog ?? [] : undefined);
    const loading = agy && this.agyLoading;
    const test = this.tests.state(target);
    const effortDisplay = options.efforts.find(e => e.value === options.effortValue)?.label
      ?? (loading ? '加载中…' : options.storedEffort ?? (agy && this.agyError ? '未获取' : '无档位'));
    const modelDisplay = options.models.find(m => m.value === model)?.label ?? model ?? '默认';
    const baseInfo = (): PreviewLine[] => [
      { label: '目标 ID', text: target.id, style: targetColor(target) },
      { label: '适配器', text: target.adapter.id },
      { label: '当前模型', text: modelDisplay },
      { label: '思考强度', text: effortDisplay },
      { label: '实施能力', text: target.adapter.capabilities.exec ? '支持实施' : '仅回答', style: DIM },
    ];

    return [
      {
        label: '模型',
        value: modelDisplay,
        valueStyle: GOLD,
        chevron: true,
        scope: 'project',
        summary: '为当前项目覆盖该目标使用的模型，选择「继承配置」将恢复全局或默认模型。',
        preview: baseInfo,
        open: () => {
          if (loading) return;
          const override = parseConfig(readJson(projectConfigPath(this.cwd)) ?? {}).models?.[id];
          const inherit = model && !override ? `继承配置（${model}）` : '继承配置';
          const choices = [{ value: '', label: inherit }, ...options.models];
          const selected = Math.max(0, choices.findIndex(m => m.value === (override ?? '')));
          this.page(id + ' · 选择模型', '按 Enter 保存项目模型覆盖，Esc 返回', () => choices.map((choice, index) => ({
            label: choice.label,
            value: index === selected ? '● 当前' : '',
            valueStyle: GOLD,
            scope: 'project' as const,
            summary: choice.value ? `将项目配置 models.${id} 设为 ${choice.value}。` : `清除项目配置中的 models.${id}，改用用户配置或默认模型。`,
            open: () => { this.save('models', choice.value || undefined, id); this.pages.pop(); },
          })), selected);
        },
      },
      {
        label: '思考强度',
        value: effortDisplay,
        valueStyle: options.efforts.length ? '' : DIM,
        chevron: options.efforts.length > 0,
        scope: 'project',
        summary: '调整推理/思考预算档位。「默认」交由底层模型或 CLI 自行决定。',
        preview: () => [
          ...baseInfo(),
          ...(options.efforts.length ? [{ label: '可选档位', text: options.efforts.map(e => e.label).join(' / '), style: DIM }] : []),
        ],
        open: () => {
          if (!options.efforts.length) return;
          const selected = Math.max(0, options.efforts.findIndex(e => e.value === options.effortValue));
          this.page('思考强度 · ' + id, '选择推理强度档位，立即写入当前项目配置', () => options.efforts.map((effort, index) => ({
            label: effort.label,
            value: index === selected ? '● 当前' : '',
            valueStyle: GOLD,
            scope: 'project' as const,
            summary: `将 ${id} 的思考强度设置为「${effort.label}」。`,
            open: () => { this.save(options.effortField, effort.value, id); this.pages.pop(); },
          })), selected);
        },
      },
      {
        label: '测试可用性',
        value: test?.status === 'failed' ? '测试失败' : test?.message ?? '按 Enter 运行',
        valueStyle: test?.status === 'failed' ? RED : test?.status === 'passed' ? TEAL : test ? YELLOW : DIM,
        detail: test?.status === 'failed' ? test.message : undefined,
        scope: 'action',
        summary: '按当前已保存的配置向该目标发送一次简短提问，不产生会话记录。',
        preview: () => [
          ...baseInfo(),
          ...(test ? [{
            label: '测试结果',
            text: test.status === 'failed' ? `测试失败 · ${test.message}` : test.message,
            style: test.status === 'failed' ? RED : test.status === 'passed' ? TEAL : YELLOW,
          }] : []),
        ],
        open: () => { void this.tests.run(target, this.state().cfg.timeoutSec); },
      },
      ...(agy && this.agyError ? [{
        label: '重试模型列表',
        value: '加载失败',
        valueStyle: RED,
        detail: this.agyError,
        scope: 'action' as const,
        summary: '重新通过 agy 读取当前账号可用的模型及思考档位列表。',
        open: () => { void this.loadAgyCatalog(); },
      }] : []),
    ];
  }

  private chooseAnswerTargets(): void {
    const { cfg, targets } = this.state();
    const selected = new Set(cfg.providers);
    const confirm = () => {
      this.save('providers', selected.size ? [...selected] : undefined);
      this.pages.pop();
      this.message = '✓ 已保存';
      this.messageKind = 'ok';
    };
    this.pages.push({
      title: '默认回答目标',
      subtitle: '空格或点击勾选多个回答目标，Enter 保存，Esc 取消',
      index: 0,
      confirm,
      rows: () => [
        {
          label: `[${selected.size ? ' ' : 'x'}] 自动选择`,
          summary: '清除项目指定的回答目标。优先沿用用户配置，否则自动选择可用目标（决策模型除外）。',
          open: () => selected.clear(),
        },
        ...targets.map(t => ({
          label: `[${selected.has(t.id) ? 'x' : ' '}] ${t.label === t.id ? t.id : `${t.label}（${t.id}）`}`,
          value: t.model,
          accent: targetColor(t),
          preview: () => [
            { label: '目标 ID', text: t.id },
            { label: '模型', text: t.model ?? '默认模型' },
          ],
          open: () => {
            if (selected.has(t.id)) selected.delete(t.id);
            else selected.add(t.id);
          },
        })),
        { label: '保存选择', value: selected.size ? `已选 ${selected.size} 项` : '自动', open: confirm },
      ],
    });
  }

  private routing(): Row[] {
    const { cfg, targets } = this.state();
    const rows: Row[] = [{
      label: '默认回答目标',
      value: cfg.providers?.join(', ') ?? '自动',
      valueStyle: cfg.providers ? GOLD : DIM,
      chevron: true,
      scope: 'project',
      summary: '从列表勾选每次普通问答要调用的模型，或使用自动选择。',
      preview: () => [
        { label: '当前配置', text: cfg.providers?.join(', ') ?? '自动选择', style: cfg.providers ? GOLD : DIM },
        { label: '可选目标', text: targets.map(t => t.id).join(', ') || '无', style: DIM },
      ],
      open: () => this.chooseAnswerTargets(),
    }];
    const descriptions = {
      synthesizer: '多模型回答完成后，由该模型对各份回答进行匿名对比并汇总最优方案。',
      executor: '输入 /exec 或按 Ctrl+E 实施改动时，默认交给该具备执行能力的模型。',
      decider: '可选的路由决策模型，用于在提问前动态判断是否需要全部目标参与和汇总。',
    } as const;
    for (const [key, label] of [['synthesizer', '汇总模型'], ['executor', '执行模型'], ['decider', '决策模型']] as const) {
      const candidates = targets.filter(t => key !== 'executor' || t.adapter.capabilities.exec);
      rows.push({
        label,
        value: cfg[key] ?? (key === 'decider' ? '不使用' : '默认'),
        valueStyle: cfg[key] ? GOLD : DIM,
        chevron: true,
        scope: 'project',
        summary: descriptions[key],
        preview: () => [
          { label: '当前选择', text: cfg[key] ?? (key === 'decider' ? '不使用' : '恢复默认'), style: cfg[key] ? GOLD : DIM },
          { label: '候选目标', text: candidates.map(t => t.id).join(', ') || '无', style: DIM },
        ],
        open: () => {
          const items = [undefined, ...candidates.map(t => t.id)];
          const current = Math.max(0, items.indexOf(cfg[key]));
          this.page(label, descriptions[key], () => items.map(id => ({
            label: id ?? '恢复默认',
            value: id === cfg[key] ? '● 当前' : '',
            valueStyle: GOLD,
            scope: 'project' as const,
            summary: id ? `将项目的 ${label} 指定为 ${id}。` : `清除项目的 ${label} 指定，恢复默认行为。`,
            open: () => { this.save(key, id); this.pages.pop(); },
          })), current);
        },
      });
    }
    return rows;
  }

  private limits(): Row[] {
    const items = [
      ['concurrency', '回答并发数', 3, '同时运行的回答目标上限（1–64 的整数）。'],
      ['timeoutSec', '回答与汇总超时（秒）', 600, '单次模型回答或汇总调用的最长等待时间。'],
      ['decisionTimeoutSec', '决策超时（秒）', 60, '决策模型的最长等待时间，超时将回退到全部目标。'],
      ['execTimeoutSec', '执行超时（秒）', 3600, '实施代码改动任务的最长等待时间。'],
    ] as const;
    return items.map(([key, label, fallback, summary]) => {
      const val = this.state().cfg[key];
      return {
        label,
        value: String(val ?? fallback) + (val === undefined ? '（默认）' : ''),
        valueStyle: val === undefined ? DIM : GOLD,
        chevron: true,
        scope: 'project',
        summary,
        preview: () => [
          { label: '当前值', text: String(val ?? fallback), style: val === undefined ? DIM : GOLD },
          { label: '默认值', text: String(fallback), style: DIM },
        ],
        open: () => this.edit(label, String(val ?? fallback), '输入正数，留空恢复默认（' + fallback + '）', 'project', v => this.save(key, v ? Number(v) : undefined)),
      };
    });
  }

  private advanced(): Row[] {
    const { cfg } = this.state();
    const rows: Row[] = [{
      label: '全局禁用 Claude Code',
      value: cfg.disableClaude ? '● 开' : '○ 关',
      valueStyle: cfg.disableClaude ? YELLOW : DIM,
      scope: 'user',
      summary: '开启后在所有项目中禁用内置 Claude Code，跳过版本检测及引用它的别名目标。',
      preview: () => [
        { label: '当前状态', text: cfg.disableClaude ? '已全局禁用' : '已启用（默认）', style: cfg.disableClaude ? YELLOW : TEAL },
        { label: '生效范围', text: '所有项目（~/.unify/config.json）', style: VIOLET },
      ],
      open: () => this.save('disableClaude', !cfg.disableClaude),
    }];
    const jsonFields = [
      ['targets', '目标别名', '用同一个 CLI/协议配置多个带不同模型或思考强度的独立目标。'],
      ['custom', '自定义端点与命令', '添加 OpenAI 兼容网关或本地包装命令，仅从用户目录加载。'],
      ['quotaCommands', '额度查询命令', '为自定义网关或端点配置外部额度查询脚本，仅从用户目录加载。'],
    ] as const;
    for (const [key, label, summary] of jsonFields) {
      const isUser = userField(key);
      const count = Object.keys((cfg[key] as Record<string, unknown> | undefined) ?? {}).length;
      rows.push({
        label,
        value: count ? `${count} 项 · ${isUser ? '用户' : '项目'}` : (isUser ? '用户配置' : '项目配置'),
        valueStyle: isUser ? VIOLET : DIM,
        chevron: true,
        scope: isUser ? 'user' : 'project',
        summary,
        preview: () => {
          const path = isUser ? join(homedir(), '.unify', 'config.json') : join(this.cwd, 'unify.config.json');
          const entries = Object.keys((cfg[key] as Record<string, unknown> | undefined) ?? {});
          return [
            { label: '配置文件', text: isUser ? '~/.unify/config.json' : './unify.config.json', style: isUser ? VIOLET : GOLD },
            { label: '已定义项', text: entries.length ? entries.join(', ') : '（空对象 {}）', style: entries.length ? '' : DIM },
            { label: '路径', text: path, style: DIM },
          ];
        },
        open: () => {
          const path = isUser ? join(homedir(), '.unify', 'config.json') : join(this.cwd, 'unify.config.json');
          const layer = parseConfig(readJson(path) ?? {}, path);
          this.edit(label, JSON.stringify(layer[key] ?? {}), '编辑 JSON 对象，可粘贴完整内容。Ctrl+U 清空，留空清除该字段', isUser ? 'user' : 'project',
            v => this.save(key, v ? JSON.parse(v) : undefined));
        },
      });
    }
    return rows;
  }

  handleKey(k: Key): void {
    this.message = '';
    this.messageKind = 'info';
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
          case 'enter':
            save(editor.text.trim());
            this.input = undefined;
            this.message = '✓ 已保存';
            this.messageKind = 'ok';
            break;
          case 'char': case 'paste': editor.insert((k.text ?? '').replace(/[\r\n]/g, ' ')); break;
          case 'ctrl+u': editor.clear(); break;
          case 'ctrl+k': editor.killToEnd(); break;
          case 'wordback': case 'ctrl+w': editor.deleteWordBack(); break;
          case 'wordleft': editor.wordLeft(); break;
          case 'wordright': editor.wordRight(); break;
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
      if (k.name === 'down' || k.name === 'wheeldown') page.index = (page.index + 1) % rows.length;
      else if (k.name === 'up' || k.name === 'wheelup') page.index = (page.index + rows.length - 1) % rows.length;
      else if (k.name === 'home') page.index = 0;
      else if (k.name === 'end') page.index = rows.length - 1;
      else if (k.name === 'pgup') page.index = Math.max(0, page.index - 5);
      else if (k.name === 'pgdn') page.index = Math.min(rows.length - 1, page.index + 5);
      else if (k.name === 'enter') (page.confirm ?? rows[page.index]?.open)?.();
      else if (page.confirm && k.name === 'char' && k.text === ' ') rows[page.index]?.open();
      else if (k.name === 'click' && k.x !== undefined && k.y !== undefined && this.hit?.page === page) {
        const { x, y, w, first, count } = this.hit;
        if (k.x >= x && k.x < x + w && k.y >= y && k.y < y + count) {
          page.index = first + (k.y - y);
          rows[page.index]?.open();
        }
      }
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      this.messageKind = 'err';
    }
  }

  draw(s: Screen): void {
    const page = this.pages[this.pages.length - 1];
    this.hit = undefined;

    // ── Header Bar ────────────────────────────────────────────────────────
    let hx = s.put(1, 0, '✦ unify', `1;${GOLD}`) + 2;
    const crumbs = [...this.pages.map(p => p.title), ...(this.input ? [this.input.title] : [])];
    crumbs.forEach((crumb, i) => {
      const last = i === crumbs.length - 1;
      if (i > 0) hx = s.put(hx, 0, ' › ', DIM);
      hx = s.put(hx, 0, crumb, last ? `1;${GOLD}` : DIM, s.cols - 2);
    });
    const badge = `项目 · ${basename(this.cwd)}`;
    if (s.cols - textWidth(badge) - 2 > hx) s.put(s.cols - textWidth(badge) - 1, 0, badge, DIM);

    const sub = this.input ? '输入新值并按 Enter 保存，Esc 返回上一级' : page.subtitle;
    s.put(1, 1, truncate(sub, s.cols - 2), DIM);
    s.put(0, 2, '─'.repeat(s.cols), BORDER);

    const bodyTop = 3;
    const bodyH = Math.max(3, s.rows - 5);

    if (this.input) {
      this.drawInput(s, bodyTop, bodyH);
    } else {
      this.drawList(s, page, bodyTop, bodyH);
    }

    // ── Status & Footer ───────────────────────────────────────────────────
    const msgY = s.rows - 2;
    if (this.message) {
      const text = this.messageKind === 'err' ? `✗ ${this.message}` : this.message;
      const color = this.messageKind === 'err' ? RED : this.messageKind === 'ok' ? TEAL : GOLD;
      s.put(1, msgY, truncate(text, s.cols - 2), color);
    } else {
      const x1 = s.put(1, msgY, '● ', GOLD);
      const x2 = s.put(x1, msgY, '项目设置 → ./unify.config.json', DIM, s.cols - 2);
      if (x2 + 28 < s.cols) {
        const x3 = s.put(x2 + 3, msgY, '● ', VIOLET);
        s.put(x3, msgY, '凭证与命令 → ~/.unify/config.json', DIM, s.cols - 2);
      }
    }

    const hints = this.input
      ? ['Enter 保存', 'Ctrl+U 清空', 'Esc 取消']
      : page.confirm ? ['↑↓ 移动', '空格 勾选', 'Enter 保存', 'Esc 取消']
      : ['↑↓ 选择', 'Enter 进入/切换', this.pages.length > 1 ? 'Esc 返回' : 'Esc 关闭'];
    drawHints(s, s.rows - 1, hints);
  }

  private drawInput(s: Screen, top: number, h: number): void {
    const { title, hint, scope, editor } = this.input!;
    const boxW = Math.min(s.cols - 2, 92);
    const boxX = Math.max(1, Math.floor((s.cols - boxW) / 2));
    const innerW = Math.max(8, boxW - 6);
    const hintLines = wrap(toCells(hint, DIM), innerW);
    const desiredH = Math.min(11, 7 + Math.min(3, Math.max(1, hintLines.length)));
    const boxH = Math.min(h, desiredH);
    const boxY = top + Math.max(0, Math.floor((h - boxH) / 2));
    drawBox(s, boxX, boxY, boxW, boxH, `编辑 · ${title}`, GOLD, `1;${GOLD}`);

    const innerX = boxX + 3;
    if (boxH >= 5) {
      const isUser = scope === 'user';
      const dotX = s.put(innerX, boxY + 1, '● ', isUser ? VIOLET : GOLD);
      s.put(dotX, boxY + 1, truncate(isUser ? '用户配置 · ~/.unify/config.json' : '项目配置 · ./unify.config.json', innerW - 2), DIM);
    }

    const fieldY = boxY + (boxH >= 7 ? 3 : 1);
    const leftChars = editor.chars.slice(0, editor.caret).join('');
    const rightChars = editor.chars.slice(editor.caret).join('');
    const fieldInner = Math.max(6, innerW - 4);
    let visibleLeft = leftChars;
    if (textWidth(visibleLeft) > fieldInner - 2) {
      visibleLeft = '…' + Array.from(visibleLeft).slice(-Math.max(4, Math.floor(fieldInner / 2))).join('');
    }

    if (boxH >= 7) {
      drawBox(s, innerX, fieldY, innerW, 3, '', GOLD, '');
      const textX = s.put(innerX + 2, fieldY + 1, visibleLeft, '', innerX + innerW - 2);
      const caretX = s.put(textX, fieldY + 1, '▏', `1;${GOLD}`, innerX + innerW - 1);
      s.put(caretX, fieldY + 1, rightChars, '', innerX + innerW - 2);
    } else {
      const textX = s.put(innerX, fieldY, visibleLeft, '', innerX + innerW - 1);
      const caretX = s.put(textX, fieldY, '▏', `1;${GOLD}`, innerX + innerW);
      s.put(caretX, fieldY, rightChars, '', innerX + innerW);
    }

    const hintY = fieldY + (boxH >= 7 ? 4 : 2);
    const hintRoom = boxY + boxH - 1 - hintY;
    if (hintRoom > 0) {
      hintLines.slice(0, hintRoom).forEach((line, i) => s.putCells(innerX, hintY + i, line, innerX + innerW));
    }
  }

  private drawList(s: Screen, page: Page, top: number, h: number): void {
    const rows = page.rows();
    page.index = clamp(page.index, 0, Math.max(0, rows.length - 1));
    const wide = s.cols >= 76;
    const leftW = wide ? clamp(Math.floor(s.cols * 0.54), 36, 66) : s.cols - 2;
    const rightX = leftW + 2;
    const rightW = s.cols - rightX - 1;
    const selectedRow = rows[page.index];

    // If narrow and selected row has detail, reserve compact detail lines below the list box.
    const detailLines = !wide && selectedRow?.detail ? wrap(toCells(selectedRow.detail.replace(/\s+/g, ' '), RED), s.cols - 4) : [];
    const narrowDetailH = detailLines.length ? Math.min(3, detailLines.length, Math.max(0, h - 5)) : 0;
    const listH = Math.max(3, h - (narrowDetailH ? narrowDetailH + 1 : 0));

    drawBox(s, 1, top, leftW, listH, page.title, GOLD, `1;${GOLD}`);
    const room = Math.max(1, listH - 2);
    const first = Math.max(0, page.index - room + 1);
    const count = Math.min(room, rows.length - first);
    this.hit = { page, x: 2, y: top + 1, w: leftW - 2, first, count };

    const innerW = Math.max(8, leftW - 4);
    rows.slice(first, first + room).forEach((r, i) => {
      const y = top + 1 + i;
      const on = i + first === page.index;
      const valText = r.value ? `${r.value}${r.chevron ? ' ›' : ''}` : (r.chevron ? '›' : '');
      const maxValW = Math.min(textWidth(valText), Math.floor(innerW * 0.48));
      const shownVal = valText ? truncate(valText, maxValW) : '';
      const valW = shownVal ? textWidth(shownVal) : 0;
      const labelMax = Math.max(4, innerW - 2 - (valW ? valW + 2 : 0));

      s.put(3, y, on ? '›' : ' ', on ? `1;${GOLD}` : '');
      s.put(5, y, truncate(r.label, labelMax), on ? `1;${GOLD}` : (r.accent ?? ''), 5 + labelMax);
      if (shownVal) {
        const vx = leftW - 1 - valW;
        const vst = r.valueStyle ?? (on ? GOLD : DIM);
        s.put(vx, y, shownVal, vst, leftW);
      }
    });

    // Scrollbar thumb on right border when list overflows.
    if (rows.length > room) {
      const thumbH = Math.max(1, Math.round((room * room) / rows.length));
      const thumbY = Math.round(((room - thumbH) * first) / Math.max(1, rows.length - room));
      for (let i = 0; i < thumbH; i++) s.put(leftW, top + 1 + thumbY + i, '┃', GOLD);
    }

    if (wide && rightW >= 20 && selectedRow) {
      this.drawInspector(s, rightX, top, rightW, h, selectedRow);
    } else if (narrowDetailH > 0) {
      detailLines.slice(0, narrowDetailH).forEach((line, i) => s.putCells(2, top + listH + 1 + i, line, s.cols - 2));
    }
  }

  private drawInspector(s: Screen, x: number, y: number, w: number, h: number, row: Row): void {
    drawBox(s, x, y, w, h, row.label, BORDER, '1');
    const ix = x + 2;
    const iw = Math.max(8, w - 4);
    const maxY = y + h - 1;
    let cy = y + 1;

    if (row.scope && cy < maxY) {
      const scopeInfo = row.scope === 'user'
        ? { dot: VIOLET, text: row.scopeText ?? '用户配置 · ~/.unify/config.json' }
        : row.scope === 'action'
          ? { dot: TEAL, text: row.scopeText ?? '即时操作 · 不写入会话记录' }
          : { dot: GOLD, text: row.scopeText ?? '项目配置 · ./unify.config.json' };
      const tx = s.put(ix, cy, '● ', scopeInfo.dot, ix + iw);
      s.put(tx, cy, truncate(scopeInfo.text, iw - 2), DIM, ix + iw);
      cy += 2;
    }

    if (row.summary && cy < maxY) {
      const lines = wrap(toCells(row.summary, ''), iw);
      for (const line of lines) {
        if (cy >= maxY) break;
        s.putCells(ix, cy++, line, ix + iw);
      }
      cy++;
    }

    if (row.detail && cy < maxY) {
      if (cy < maxY) s.put(ix, cy++, '错误详情', `1;${RED}`, ix + iw);
      const lines = wrap(toCells(row.detail.replace(/\s+/g, ' '), RED), iw);
      for (const line of lines) {
        if (cy >= maxY) break;
        s.putCells(ix, cy++, line, ix + iw);
      }
      cy++;
    }

    const preview = row.preview?.();
    if (preview?.length && cy < maxY) {
      const labelW = Math.min(Math.max(0, ...preview.map(p => textWidth(p.label ?? ''))), Math.floor(iw * 0.42));
      for (const item of preview) {
        if (cy >= maxY) break;
        if (item.label) {
          s.put(ix, cy, truncate(item.label, labelW), DIM, ix + labelW);
          const vx = ix + labelW + 2;
          const avail = Math.max(4, ix + iw - vx);
          const wrapped = wrap(toCells(item.text, item.style ?? ''), avail);
          for (const line of wrapped.slice(0, 2)) {
            if (cy >= maxY) break;
            s.putCells(vx, cy++, line, ix + iw);
          }
        } else {
          s.put(ix, cy++, truncate(item.text, iw), item.style ?? '', ix + iw);
        }
      }
    }
  }
}
