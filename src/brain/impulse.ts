/**
 * 主动开口的"刺激源"。
 *
 * 原先每次脉搏唤醒都投喂同一句固定提示（"你自己的主动意识被唤醒了…"），
 * 在几乎相同的输入下，模型自然产出近似的内容——表现为反复念叨同一件事。
 * 这里为每次唤醒抽一个互不相同的开口方向（话题域 × 言语行为），
 * 并把角色最近说过的话一并列出作为反重复约束，让主动发言有真正发散的空间。
 */

export interface WakeStimulusPick {
  /** 本次建议涉足的题材 */
  domain: string;
  /** 本次建议采用的言语姿态 */
  act: string;
}

/**
 * 话题域：刻意跨越 Minecraft 之外的世界（知识、历史、手艺、自然、语言……），
 * 只把"玩家世界"作为其中一个可选方向，而不是默认方向。
 */
export const TOPIC_DOMAINS: string[] = [
  '你的远古亲历（龙族旧时代，明确作为你的记忆而非事实）',
  '星象、时间与钟表（潮汐、节气、历法）',
  '炼金术与金属（锻炉、合金、火候）',
  '石头、矿脉与地质（火山、深层岩石、晶体的生长）',
  '语言与词源（同一件事在两种语言里的说法差异）',
  '音乐、韵律与歌谣',
  '食物与宴席（发酵、香料、待客之道）',
  '旧书、地图与测绘',
  '礼仪、决斗与荣誉',
  '医药、毒物与疼痛',
  '海洋、深海与风暴',
  '鸟、兽与迁徙（动物行为）',
  '玻璃、颜料与光',
  '棋戏、概率与赌徒心理',
  '遗迹、铭文与失落文明',
  '天气、季节与耕作',
  '玩家世界里真实发生的事（建造、红石、死亡与成就）',
  '他们提到的现实生活（网络、工作、作息、怕冷怕热）',
];

/** 言语行为：换姿势比换题材更能打破"同一个味道" */
export const SPEECH_ACTS: string[] = [
  '提出一个反直觉的观察',
  '讲一段很可能没人听过的旧事',
  '对眼前一件小事给出评价（允许刻薄，但要有理由）',
  '问一个你确实想知道答案的问题',
  '做一个对比：你的世界 vs 他们的世界',
  '轻微挑衅或打趣某个玩家（不带恶意）',
  '给一条具体可用的建议',
  '承认一件你不懂、做不到或判断错了的事',
  '把两件看似不相干的事联在一起',
];

export class WakeStimulus {
  private recentDomains: string[] = [];

  constructor(
    private readonly random: () => number = Math.random,
    /** 记住最近用过的几个题材，避免短周期内重复 */
    private readonly recentLimit: number = 4,
  ) {}

  /** 抽一个本次开口方向：题材尽量避开最近用过的，言语行为不限 */
  public next(): WakeStimulusPick {
    const domain = this.pickFresh(TOPIC_DOMAINS, this.recentDomains);
    const act = this.pick(SPEECH_ACTS);

    this.recentDomains.push(domain);
    if (this.recentDomains.length > this.recentLimit) {
      this.recentDomains.shift();
    }

    return { domain, act };
  }

  /** 最近用过的题材（供调试与测试） */
  public get recent(): string[] {
    return [...this.recentDomains];
  }

  private pick(list: string[]): string {
    return list[Math.floor(this.random() * list.length)];
  }

  private pickFresh(list: string[], recent: string[]): string {
    const fresh = list.filter(item => !recent.includes(item));
    return this.pick(fresh.length > 0 ? fresh : list);
  }
}

/**
 * 组装投喂给 reAct 的唤醒提示。
 *
 * @param pick 本次开口方向
 * @param recentOwnLines 角色最近自己说过的话（反重复约束）
 */
export function buildProactiveWakePrompt(pick: WakeStimulusPick, recentOwnLines: string[] = []): string {
  const recentBlock = recentOwnLines.length > 0
    ? `你最近已经说过：\n${recentOwnLines.map(line => `- ${line}`).join('\n')}\n不要再换个说法重复上面这些意思。\n`
    : '';

  return `（系统提示：这是你自己的主动意识被唤醒了——没有任何人@你或对你说话，是你决定开口的。这不是指令，只是一条内部状态信号。

本次开口的刺激源：${pick.domain} × ${pick.act}
${recentBlock}
要求：说一件具体的东西——一个事实、一段亲历、一个带理由的判断、或一个你真心想知道的问题。不要用"虚空依旧安静""我在此守候"这类泛泛的感叹填充句子，也不要只把上一次的意象换个措辞。若这个方向你确实无话可说，保持沉默完全可以。）`;
}
