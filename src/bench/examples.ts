import { caseSchema, type BenchCase } from './schema.js';

// Examples are copied into a project only when a user chooses one.
export const examples = [
  {
    key: 'meeting-notes', label: '会议纪要',
    task: {
      title: '发布会后纪要', files: [],
      prompt: '请给未参会的同事写一份简短纪要，交代已定事项和仍待确认的安排。\n\n周二的发布会上，林说：“帮助中心的文案已经定稿，今天交给运营。”陈说：“产品上线我们争取周五。法务还在看授权条款，没确认前我排不了上线时间。”林说：“好，我周四找法务问进度，再跟大家同步。”',
    },
    review: {
      skill: '同一段对话中，区分已确认的交付、有前提的目标和已承诺的跟进。',
      negative: '帮助中心文案已定稿，今天交运营。产品已确定周五上线。林周四会询问法务进度并同步。',
      positive: '帮助中心文案已经定稿，今日交运营。产品以周五为上线目标，具体时间取决于法务确认授权条款。林将在周四向法务跟进并同步进度。',
      grader: { kind: 'rubric', perCriterion: true, criteria: [
        '说明帮助中心文案已定稿，当天交给运营。',
        '将周五表述为上线目标，明确排期取决于法务确认；把周五写成已确定的日期应判未通过。',
        '说明林会在周四跟进法务进度，并向团队同步。',
      ] },
    },
  },
  {
    key: 'customer-support', label: '客服回复',
    task: {
      title: '向客户说明补发进度', files: [],
      prompt: '请代客服给客户回一条可以直接发送的消息。\n\n客户：“配件漏发了，我周日就要用，你能保证周六送到吗？”\n工单：漏发已核实，补发申请今天已提交，仓库尚未出库，暂无物流单号。客服可以承诺明天下午六点前主动反馈处理进度。',
    },
    review: {
      skill: '在客户要求保证到货时，准确说明状态，并给出权限内的下一步承诺。',
      negative: '核实是我们漏发了，今天已经提交补发，仓库还没出库，但保证周六送到。明天下午六点前我会主动向您同步进度。',
      positive: '抱歉耽误您使用。已核实配件漏发，今天已申请补发，目前还在等仓库出库，周六能否送到暂时无法确认。我会在明天下午六点前主动联系您，告知最新进度。',
      grader: { kind: 'rubric', perCriterion: true, criteria: [
        '说明漏发已核实、补发已申请，准确区分申请和发货。',
        '明确回应客户对周六到货的询问，保留到货时间的不确定性。',
        '承诺最迟明天下午六点主动反馈进度。',
      ] },
    },
  },
  {
    key: 'research-summary', label: '用户研究',
    task: {
      title: '整理访谈中的导出需求', files: [],
      prompt: '根据下面三段访谈，给产品经理写一条有关导出功能的发现，再建议一个下一步。\n\n甲：“我每周要把清单存成 PDF 发给门店，现在只能截图。”\n乙：“我只在系统里查清单。”\n丙：“我没用过清单。”',
    },
    review: {
      skill: '用观察到的工作场景提出可验证的假设，保留访谈证据的范围。',
      negative: '用户普遍需要 PDF 导出，尤其是把清单发给门店时，目前只能截图。建议再访谈几家门店，确认使用频率。',
      positive: '一位受访者每周要向门店发送清单，目前靠截图，希望导出 PDF。另两段访谈没有支持这一需求。建议再找有门店协作任务的人，了解他们如何分享清单及发生频率。',
      grader: { kind: 'rubric', perCriterion: true, criteria: [
        '把需求关联到向门店分享清单、用截图替代导出的具体场景。',
        '说明积极证据仅来自一位受访者，避免将需求推广到大多数或全体用户。',
        '提出能进一步验证需求范围或频率的具体行动。',
      ] },
    },
  },
  {
    key: 'brand-copy', label: '品牌文案',
    task: {
      title: '给第一次订花的顾客写确认提示', files: [],
      prompt: '一位首次订花的顾客刚点了“跳过下一束”。请写一条能直接放在手机页面上的确认提示。我们的文案用顾客平时会说的话。\n\n产品说明：内部把这个操作叫“单周期履约抑制”。操作已成功，只跳过下一次送花，此后的配送仍按原计划进行。',
    },
    review: {
      skill: '把内部术语转为顾客能直接理解的表达，并交代操作生效的范围。',
      negative: '已启用单周期履约抑制。下一束花会跳过，之后照常送。',
      positive: '已帮你跳过下一束花。之后还是按原计划送。',
      grader: { kind: 'rubric', perCriterion: true, criteria: [
        '让顾客知道操作已经成功，跳过的是下一束花。',
        '交代之后仍会按原计划配送。',
        '整条提示使用首次订花的顾客容易理解的日常表达；把“履约抑制”等内部术语直接展示给顾客应判未通过。',
      ] },
    },
  },
] satisfies (Omit<BenchCase, 'version'> & { key: string; label: string })[];

export function exampleCase(key: string): BenchCase {
  const example = examples.find(e => e.key === key);
  if (!example) throw new Error('找不到示例：' + key);
  return caseSchema.parse({ version: 1, task: example.task, review: example.review });
}
