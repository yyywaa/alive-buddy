/**
 * 主动开口的"唤醒方式"。
 *
 * 演进过程值得留个记录：
 *  1. 最初每次唤醒都投喂同一句固定提示 —— 近似输入产出近似输出，表现为反复念叨同一件事。
 *  2. 后来改成"每跳随机指定 话题域 × 言语行为" —— 确实打破了重复，但走到另一个极端：
 *     等于每次都**强制它关注某个方面**，而且题材被框在一份人工清单里。
 *  3. 现在的做法：只给**开放邀请**（换着说法，避免输入完全雷同）+ 反重复约束（把它最近
 *     说过的话列出来）。方向、题材一律不指定 —— 它可以谈任何东西，包括清单之外的、
 *     与 Minecraft 毫无关系的东西。
 */
export interface WakeFraming {
  /** 用于日志的短标识 */
  id: string;
  /** 投喂给模型的开放邀请（不含任何题材指定） */
  invite: string;
}

/**
 * 轮换的开放邀请。
 *
 * 它们只改变"措辞与角度"，不改变"必须谈什么"：
 * 目的有二 —— 避免每次输入一字不差（固定输入会诱导固定输出），
 * 以及反复提醒它"说不说由你、说什么也由你"。
 */
export const WAKE_FRAMINGS: WakeFraming[] = [
  {
    id: 'open',
    invite: '此刻没有人在跟你说话。你想说什么就说什么，不想说就沉默——决定权在你。',
  },
  {
    id: 'drift',
    invite: '这段安静里，你脑子里冒出了什么？有就讲，没有就算了。',
  },
  {
    id: 'notice',
    invite: '看一眼眼前这个世界，有没有什么值得你开口的由头。',
  },
  {
    id: 'free-association',
    invite: '不必围绕眼前这件事。你此刻想到什么都可以说，多远都行。',
  },
  {
    id: 'no-agenda',
    invite: '没有议题，也没人点你。如果你确实有话想说，就说。',
  },
  {
    id: 'mood',
    invite: '你现在的状态如何？若有什么想说的、想吐槽的、想打听的，随意。',
  },
];

export class WakeStimulus {
  private recent: string[] = [];

  constructor(
    private readonly random: () => number = Math.random,
    /** 记住最近用过的措辞，避免短期内重复同一种开场 */
    private readonly recentLimit: number = 3,
  ) {}

  /** 抽一个本次的开放邀请（只换措辞，不指定题材） */
  public next(): WakeFraming {
    const fresh = WAKE_FRAMINGS.filter(f => !this.recent.includes(f.id));
    const pool = fresh.length > 0 ? fresh : WAKE_FRAMINGS;
    const pick = pool[Math.floor(this.random() * pool.length)];

    this.recent.push(pick.id);
    if (this.recent.length > this.recentLimit) {
      this.recent.shift();
    }
    return pick;
  }

  /** 最近用过的措辞 id（供调试与测试） */
  public get recentIds(): string[] {
    return [...this.recent];
  }
}

/**
 * 组装投喂给 reAct 的唤醒提示。
 *
 * @param framing 本次的开放邀请
 * @param recentOwnLines 角色最近自己说过的话（反重复约束）
 */
export function buildProactiveWakePrompt(framing: WakeFraming, recentOwnLines: string[] = []): string {
  const recentBlock = recentOwnLines.length > 0
    ? `\n你最近已经说过：\n${recentOwnLines.map(line => `- ${line}`).join('\n')}\n` +
      `不要再换个说法重复上面这些意思；也留意**腔调是否合场合**——谈人类的事可以学者腔，` +
      `谈龙、末地、你自己就该是末影龙在说话，而不是同一种嗓子从头用到尾。\n`
    : '';

  return `（系统提示：这是你自己的主动意识被唤醒了——没有任何人@你或对你说话，是你决定开口的。这不是指令，只是一条内部状态信号。

${framing.invite}
${recentBlock}
没有任何限定：题材随你，可以完全与眼前的世界无关，也不必挑"像你会说的话题"。
只要求是具体的东西——你自己见过或做过的一件事、一个带理由的判断、一个你真心想知道的问题，
而不是泛泛的感叹，也不是复述资料（你活得太久，不必靠引用来证明什么）。
若确实无话可说，保持沉默完全可以。）`;
}
