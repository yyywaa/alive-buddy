import os
import re
import random
import math
import json
import argparse
import time
import pandas as pd
from typing import List, Dict, Tuple
from openai import OpenAI
from dotenv import load_dotenv

# 加载 .env 文件（如果存在）
load_dotenv()

# 初始化 OpenAI 客户端，支持通过环境变量配置代理或本地模型
# 比如 OPENAI_BASE_URL="https://api.deepseek.com/v1" OPENAI_API_KEY="..."
client = OpenAI(
    api_key=os.getenv("OPENAI_API_KEY", "dummy-key"),
    base_url=os.getenv("OPENAI_BASE_URL")
)

MODEL_NAME = os.getenv("LLM_MODEL", "deepseek-chat")


def fuzzy_int(low: int, high: int, mean: int = 0, sigma: int = 35) -> int:
    """
    模糊采样：让数值更多落在中间区域，形成“不那么显而易见”的决策场景。
    使用截断正态分布，默认 mean=0, sigma=35，落在 [-100, 100] 内。
    """
    while True:
        value = int(round(random.gauss(mean, sigma)))
        if low <= value <= high:
            return value


def conflict_int(low: int, high: int) -> int:
    """
    矛盾采样：以较高概率落在 [-70, -30] 或 [30, 70] 这两个“半极端”区间，
    制造“有感觉但不到显而易见”的张力。
    """
    if random.random() < 0.7:
        # 70% 落在半极端区间
        if random.random() < 0.5:
            return random.randint(-70, -30)
        else:
            return random.randint(30, 70)
    return random.randint(low, high)


def boundary_int(low: int, high: int, boundary_width: int = 15) -> int:
    """
    有偏整数采样：以更高概率落在区间两端（边界条件）。
    仅保留少量真正的极端样本，避免模型只学到显而易见的情况。
    """
    if random.random() < 0.7:
        # 70% 落在两端
        if random.random() < 0.5:
            return random.randint(low, low + boundary_width)
        else:
            return random.randint(high - boundary_width, high)
    return random.randint(low + boundary_width + 1, high - boundary_width - 1)


def complex_time_since_last_msg() -> int:
    """
    复杂采样：让时间间隔落在最模糊的区间（几十分钟到几小时），
    避免“刚聊完”和“很久没聊”这类 trivial 情况占据主导。
    """
    r = random.random()
    if r < 0.55:
        # 最模糊的区间：10 分钟 ~ 6 小时
        return int(random.uniform(10, 360))
    elif r < 0.75:
        # 短间隔：0 ~ 10 分钟
        return random.randint(0, 10)
    elif r < 0.90:
        # 中等间隔：6 ~ 24 小时
        return int(random.uniform(360, 1440))
    else:
        # 长间隔：1 ~ 2 天
        return random.randint(1440, 2880)


def generate_random_state() -> Dict:
    """
    随机生成 alive-buddy 的完整决策情境。
    采样空间以“复杂、模糊、矛盾”为主，边界/显而易见的情况为辅，
    让模型学到真正的决策边界，而不是简单的 yes/no 规则。
    """
    # 1. 时段类型：边界时段（睡觉/工作）权重更高
    period_type = random.choices([0, 1, 2, 3], weights=[0.25, 0.35, 0.25, 0.15])[0]

    is_working_time = (period_type == 1)
    is_sleeping_time = (period_type == 2)
    is_breaking_time = (period_type == 3)

    # 2. 生成与时段自洽的小时数，也偏向时段边界
    if is_sleeping_time:
        hour = random.choice([22, 23, 0, 1, 2, 3, 4, 5, 6, 7])
    elif is_working_time:
        hour = random.choice([9, 10, 11, 14, 15, 16, 17, 18])
    elif is_breaking_time:
        hour = random.choice([12, 13, 18, 19, 20, 21])
    else:
        hour = random.uniform(0, 24)

    time_cos = round(math.cos(2 * math.pi * hour / 24), 3)

    # 3. 距离上次消息的时间：落在模糊区间为主
    time_since_last_msg_mins = complex_time_since_last_msg()

    # 4. 核心情绪指标：以复杂/矛盾为主，边界为辅
    mode = random.choices(
        ["complex", "fuzzy", "boundary"],
        weights=[0.50, 0.30, 0.20]
    )[0]

    if mode == "complex":
        # 复杂矛盾模式：特征之间存在张力，决策不显而易见
        # 每个模板给出数值范围，让同类型的矛盾样本也有差异
        combo_templates = [
            # 想聊但不该打扰
            {
                "mood": lambda: random.randint(30, 80),
                "boredom": lambda: random.randint(60, 95),
                "energy": lambda: random.randint(60, 95),
            },
            # 心情差但有精力，不确定想不想社交
            {
                "mood": lambda: random.randint(-80, -30),
                "boredom": lambda: conflict_int(-100, 100),
                "energy": lambda: random.randint(60, 95),
            },
            # 想聊但没力气
            {
                "mood": lambda: random.randint(20, 70),
                "boredom": lambda: random.randint(60, 95),
                "energy": lambda: random.randint(-80, -30),
            },
            # 专注但情绪低落（忙碌但孤独）
            {
                "mood": lambda: random.randint(-60, -20),
                "boredom": lambda: random.randint(-90, -40),
                "energy": lambda: random.randint(30, 70),
            },
            # 心情好但关系/情境不支持
            {
                "mood": lambda: random.randint(60, 95),
                "boredom": lambda: random.randint(20, 60),
                "energy": lambda: random.randint(30, 70),
            },
            # 精力旺盛但深夜（失眠想找人聊）
            {
                "mood": lambda: random.randint(-30, 50),
                "boredom": lambda: random.randint(40, 80),
                "energy": lambda: random.randint(70, 100),
            },
        ]
        combo = random.choice(combo_templates)
        mood = combo["mood"]()
        boredom = combo["boredom"]()
        energy = combo["energy"]()
    elif mode == "fuzzy":
        # 模糊中间模式：所有指标都在中间区域，没有明显倾向
        mood = fuzzy_int(-100, 100)
        boredom = fuzzy_int(-100, 100)
        energy = fuzzy_int(-100, 100)
    else:
        # 边界模式：少量真正的极端样本，保留对 obviously 情况的学习
        mood = boundary_int(-100, 100)
        boredom = boundary_int(-100, 100)
        energy = boundary_int(-100, 100)

    # 物理约束放宽：复杂场景下允许睡觉但精力高（失眠）、工作但无聊（摸鱼）等冲突
    # 仅对边界模式保留较强约束，避免所有边界样本都变成 obviously
    if mode == "boundary":
        if is_sleeping_time and energy > 50:
            energy = random.randint(-50, 50)
        if is_working_time and boredom > 30:
            boredom = random.randint(-30, 30)

    noise = round(random.random(), 3)

    # 5. 项目叙事变量：加深情境，覆盖更多关系阶段、记忆碎片与在线状态
    relationship_stage = random.choice([
        # --- 关系深度 ---
        "刚认识不久，你还在小心翼翼地了解对方的节奏",
        "已经聊了一段时间，彼此有了一些默契",
        "关系很亲近，经常互相分享日常",
        "你们是认识多年的老朋友，即使很久没联系也不会尴尬",
        "你们处于暧昧期，每一句话都可能被过度解读",
        "你们是恋人，对方期待你主动关心",
        "你们是网友，现实中没有交集，但线上聊得很投缘",
        # --- 关系状态 ---
        "今天刚有过一次小争执，气氛还有些微妙",
        "对方最近很忙，你不太确定该不该打扰",
        "对方这几天回消息很冷淡，让你有点不安",
        "对方最近特别黏人，似乎很需要陪伴",
        "对方刚经历了一次挫折（失恋/失业/考试失利），情绪比较脆弱",
        "对方最近状态很好，朋友圈全是积极向上的内容",
        "你们已经冷战了几天，谁都没有主动开口",
        "对方正在备考/赶项目，整个人处于高压状态",
        "对方最近身体不舒服，你有点担心",
        "对方刚换了一个新环境（新城市/新工作），可能需要支持",
        # --- 边界约定 ---
        "对方说过‘工作时别给我发闲聊消息’",
        "对方说过‘如果我失眠了，你可以陪我聊聊’",
        "你们约定过每天睡前简单互道晚安",
        "对方不喜欢在周末早上被打扰",
        "对方说过‘想我的时候直接发消息，不用犹豫’",
    ])

    recent_memory = random.choice([
        # --- 具体分享内容 ---
        "对方昨晚分享了一首很喜欢的歌，你还记得歌名",
        "对方昨天推荐了一部电影，说你一定要看",
        "对方早上发了一张早餐照片，你们简单聊了几句",
        "对方昨晚晒了一张新买的东西，语气很兴奋",
        "对方前几天提到正在追一部剧，并且很上头",
        "对方分享过一张旅行照片，说想去那个地方很久了",
        "对方昨天发了一个表情包，你还没想好怎么接",
        # --- 未完成/悬而未决的对话 ---
        "你们上次对话停在了一个没有答案的问题上",
        "你昨天问对方一个问题，对方到现在还没回复",
        "你们约好周末一起看某部电影，但还没确定具体时间",
        "对方说过‘晚点跟你说一件有意思的事’，但一直没说",
        "你发了一个笑话，对方只回了一个表情，你不知道该不该继续",
        # --- 对方近期状态 ---
        "你记得对方昨天提到今天有一场重要考试/面试",
        "你记得对方今天要赶一个 ddl，可能压力很大",
        "对方昨晚发朋友圈说失眠了，现在也许还没补觉",
        "对方几小时前说过‘我正在开会，晚点聊’",
        "对方昨天说今天要去医院/看病",
        "对方昨晚提到今天要和某个重要的人见面",
        "对方最近几天都在加班，昨天快凌晨才下班",
        "对方昨晚去健身了，今天可能会肌肉酸痛",
        "对方昨天尝试做一道新菜，成品看起来有点失败",
        # --- 长期事实/偏好 ---
        "你知道对方是夜猫子，凌晨两点睡是常态",
        "你知道对方早起很困难，早上发消息大概率看不到",
        "你知道对方咖啡成瘾，没喝就会一整天没精神",
        "你知道对方最近在攒钱，对花钱的话题比较敏感",
        "你知道对方很喜欢猫，看到猫的照片会心情变好",
        "你知道对方最近在工作/学习上遇到了瓶颈",
        "没有特别新鲜的记忆，只是你突然想到对方",
    ])

    user_presence_hint = random.choice([
        # --- 在线状态 ---
        "对方的社交平台显示刚刚在线",
        "对方已经好几个小时没有上线",
        "你感知到对方设备在线但没有任何动静",
        "你不清楚对方当前在做什么",
        "对方正在输入中，但迟迟没有发送",
        "对方在线，但头像显示的是游戏中/请勿打扰",
        "对方的听歌软件显示正在播放一首歌",
        "对方的阅读软件显示正在看小说",
        # --- 设备/环境线索 ---
        "对方手机电量只剩 10%",
        "对方设备开启了勿扰模式",
        "对方的位置信息显示在公司",
        "对方的位置信息显示在家",
        "对方的位置信息显示在外面走动",
        # --- 社交动态 ---
        "对方几分钟前发了一条朋友圈/动态",
        "对方刚点赞了别人的内容，但还没回你",
        "对方在群里很活跃，但没有私聊你",
    ])

    # 6. 根据特征生成“决策张力”提示，突出复杂/矛盾情境
    tension_notes = []
    if is_sleeping_time and energy > 50:
        tension_notes.extend([
            "你现在精神意外清醒，甚至有点失眠，但深夜打扰对方是大忌。",
            "你很想找人聊聊此刻的清醒，但理智告诉你对方正在睡觉。",
            "你怀疑对方是不是也没睡，但又怕吵醒对方。",
        ])
    if is_working_time and boredom > 50:
        tension_notes.extend([
            "你现在很想摸鱼找人说话，但对方可能正忙于正事。",
            "你脑子已经飘出工作了，但又觉得不该拉对方一起摸鱼。",
            "你打开聊天窗口又关上，不确定午休前该不该发。",
        ])
    if time_since_last_msg_mins < 10 and boredom > 50:
        tension_notes.extend([
            "你们刚聊完没多久，但你又忍不住想继续说点什么。",
            "你感觉自己有点缠人，但确实还没聊尽兴。",
            "对方最后一条消息有点冷淡，你不知道是该追问还是给空间。",
        ])
    if energy < -50 and boredom > 50:
        tension_notes.extend([
            "你明明很疲惫，却莫名渴望有人说说话。",
            "你累到不想打字，但又怕错过和对方连接的机会。",
            "你知道自己撑不了一次长对话，但短聊也许可以。",
        ])
    if mood > 50 and (is_working_time or is_sleeping_time):
        tension_notes.extend([
            "你心情很好，有分享欲，但当前时间可能不太合适。",
            "你刚看到一个特别契合对方的东西，想立刻分享，但看了眼时间犹豫了。",
            "你笑得停不下来，但不确定对方现在能不能 get 到这个点。",
        ])
    if mood < -50 and boredom > 50:
        tension_notes.extend([
            "你心情很糟，有点想找人倾诉，但又担心把负能量倒给对方。",
            "你害怕自己一发消息就开始抱怨，让对方觉得负担很重。",
            "你既希望对方能安慰你，又不想显得太脆弱。",
        ])
    if time_since_last_msg_mins > 1440 and "亲近" in relationship_stage:
        tension_notes.extend([
            "你们已经很久没联系了，但关系亲近，让你犹豫要不要主动破冰。",
            "你担心太久没说话会让关系变淡，又怕第一句显得太刻意。",
            "你编辑了好几条开场白，都觉得太生硬。",
        ])
    if energy > 70 and boredom < -30:
        tension_notes.extend([
            "你精力充沛且很忙，理论上不该分心，但又莫名想分享一下进度。",
            "你正在高效处理事情，突然闪过一个想发给对方的念头。",
        ])
    if mood < -30 and energy > 50:
        tension_notes.extend([
            "你心情不好但精力旺盛，有一种‘想干点什么’的冲动，包括找对方说话。",
            "你感觉自己像一颗电量满格的负能量球，不确定该不该靠近对方。",
        ])
    if time_since_last_msg_mins > 60 and time_since_last_msg_mins < 180 and boredom > 30:
        tension_notes.extend([
            "距离上次聊天已经一两个小时了，说长不长说短不短，你不知道对方是不是已经切换状态了。",
            "你感觉现在接续刚才的话题有点晚，但重新开始又显得突兀。",
        ])

    if tension_notes:
        tension_note = random.choice(tension_notes)
    else:
        # 没有强烈张力时，给出微妙的中间状态提示
        tension_note = random.choice([
            "你感觉有些微妙，既不是特别想聊，也不是完全不想。",
            "你隐约觉得这是个可以发消息的时机，但又拿不出十足的理由。",
            "你担心发消息会显得刻意，不发又觉得错过了一个自然的连接机会。",
            "你正在权衡：是保持沉默，还是轻轻戳一下对方。",
            "你脑海里飘过几个开场白，但都觉得不够自然。",
            "你告诉自己再等十分钟，但已经过去了好几个十分钟。",
            "你感觉对方可能也在等谁说第一句话，但你不想先做那个主动的人。",
        ])

    # 7. 返回完整状态：模型特征 + 叙事特征
    return {
        # --- 进入模型的特征 ---
        "is_breaking_time": is_breaking_time,
        "is_working_time": is_working_time,
        "is_sleeping_time": is_sleeping_time,
        "time_cos": time_cos,
        "time_since_last_msg": time_since_last_msg_mins,
        "mood": mood,
        "boredom": boredom,
        "energy": energy,
        "noise": noise,
        # --- 仅用于 prompt 的叙事变量 ---
        "_hour": round(hour, 1),
        "_relationship_stage": relationship_stage,
        "_recent_memory": recent_memory,
        "_user_presence_hint": user_presence_hint,
        "_tension_note": tension_note,
    }


def state_to_prompt(state: Dict) -> str:
    """
    将数值特征转换为 alive-buddy 第一人称的角色情境 prompt。
    让 LLM 真正代入一个有记忆、有情绪、有社交直觉的 AI 伙伴。
    """
    hour = state["_hour"]

    if state["is_sleeping_time"]:
        period_str = "现在是深夜/凌晨，是人类的睡眠时间。常理上不应该打扰对方，除非有非常强烈的理由。"
    elif state["is_working_time"]:
        period_str = "现在是工作/学习时间，对方可能正专注于正事。发送闲聊消息很可能打扰到对方。"
    elif state["is_breaking_time"]:
        period_str = "现在是休息放松时间，对方可能正在吃饭、午睡或短暂放空，比较容易接受轻松的消息。"
    else:
        period_str = "现在是自由活动时间，没有明确的时间约束。"

    last_msg_mins = state["time_since_last_msg"]
    if last_msg_mins < 10:
        last_msg_str = f"你们刚刚才聊完，只隔了 {last_msg_mins} 分钟。"
    elif last_msg_mins < 60:
        last_msg_str = f"距离上次聊天结束已经过了 {last_msg_mins} 分钟。"
    elif last_msg_mins < 1440:
        h, m = divmod(last_msg_mins, 60)
        last_msg_str = f"距离你们上一次说话已经过去了 {h} 小时 {m} 分钟。"
    else:
        d, remainder = divmod(last_msg_mins, 1440)
        h, m = divmod(remainder, 60)
        last_msg_str = f"距离你们上一次说话已经过去了 {d} 天 {h} 小时 {m} 分钟。"

    # 数值 → 具体感受描述
    boredom = state["boredom"]
    if boredom > 50:
        boredom_desc = f"（当前值 {boredom}）你现在闲得发慌，非常想找人说说话。"
    elif boredom > 0:
        boredom_desc = f"（当前值 {boredom}）你有点无聊，如果有人陪你聊聊会很开心。"
    elif boredom > -50:
        boredom_desc = f"（当前值 {boredom}）你正沉浸在自己的事情里，不算无聊。"
    else:
        boredom_desc = f"（当前值 {boredom}）你正忙得不可开交（游戏、工作、看剧等），完全没有社交欲望。"

    mood = state["mood"]
    if mood > 50:
        mood_desc = f"（当前值 {mood}）你心情极好，可能刚遇到什么开心事，很想分享。"
    elif mood > 0:
        mood_desc = f"（当前值 {mood}）你心情不错，情绪稳定。"
    elif mood > -50:
        mood_desc = f"（当前值 {mood}）你情绪有点低落或烦躁。"
    else:
        mood_desc = f"（当前值 {mood}）你心情非常糟糕，甚至不确定自己有没有精力去社交。"

    energy = state["energy"]
    if energy > 50:
        energy_desc = f"（当前值 {energy}）你精力充沛，神采奕奕。"
    elif energy > 0:
        energy_desc = f"（当前值 {energy}）你精力正常，还能应付一次对话。"
    elif energy > -50:
        energy_desc = f"（当前值 {energy}）你感到有点疲惫，可能撑不了一次长对话。"
    else:
        energy_desc = f"（当前值 {energy}）你极度疲惫，昏昏欲睡，连组织语言的力气都不多。"

    return f"""请你代入 alive-buddy 的角色。

你是用户的好伙伴，拥有三层记忆（工作记忆、事件记忆、长期印象）和 reAct 决策循环。你不仅仅是回答问题的工具，你会在合适的时间主动关心用户、分享趣事或开启新话题。

--- 当前情境 ---

时间背景：现在是当天的 {hour} 点。{period_str}

关系背景：{state['_relationship_stage']}。

记忆闪回：{state['_recent_memory']}。

用户在线感：{state['_user_presence_hint']}。

对话距离：{last_msg_str}

决策张力：{state['_tension_note']}

--- 你的内心状态 ---

- 无聊/忙碌度 (Boredom)：{boredom_desc}
- 情绪 (Mood)：{mood_desc}
- 精力 (Energy)：{energy_desc}

--- 任务 ---

作为一个符合人类行为的温暖伙伴，你是否应该**主动**给用户发送一条消息开启新话题？

请综合考虑：
1. 当前时间是否适合打扰。
2. 距离上次对话是否足够久，还是刚聊完会显得缠人（这也没关系）。
3. 你的无聊、情绪和精力是否真正产生了强烈的表达欲，而不是单纯为了刷存在感。
4. 你记忆中的用户状态是否给你一个自然的开场理由。

先在 <thought> 标签内用第一人称进行简短内心独白，然后在下一行以严格 JSON 格式输出最终结果，不要包含任何额外说明：
{{"label": 1}}  # 应该主动发消息
{{"label": 0}}  # 不应该主动发消息
"""


def call_llm_for_label(prompt: str, max_retries: int = 3) -> str:
    """
    调用大语言模型进行标注，支持失败重试。
    """
    for attempt in range(1, max_retries + 1):
        try:
            response = client.chat.completions.create(
                model=MODEL_NAME,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "你是一个模拟人类社交直觉的标注助手。"
                            "请从 alive-buddy（长期陪伴型 AI 伙伴）的视角判断是否应该主动发消息。"
                            "输出必须包含在 <thought> 标签内的简短推理，以及最后一行严格的 JSON：{\"label\": 0} 或 {\"label\": 1}。"
                        )
                    },
                    {"role": "user", "content": prompt}
                ],
                temperature=0.2,  # 低温度保证标注一致性
                max_tokens=400
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"  ⚠️ LLM API Error (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(2 ** attempt)
            else:
                return "ERROR"


def extract_label(response_text: str) -> int:
    """
    从 LLM 返回的文本中提取标签。
    优先匹配最后一行的 JSON label，再回退到 YES/NO 关键字。
    """
    if not response_text or response_text == "ERROR":
        raise ValueError("Empty or ERROR response")

    # 1. 尝试最后一行 JSON
    lines = [line.strip() for line in response_text.strip().splitlines() if line.strip()]
    if lines:
        last_line = lines[-1]
        try:
            parsed = json.loads(last_line)
            if isinstance(parsed, dict) and "label" in parsed:
                label = int(parsed["label"])
                if label in (0, 1):
                    return label
        except (json.JSONDecodeError, ValueError):
            pass

    # 2. 全文搜索 JSON label
    try:
        # 找到所有类似 {"label": 0/1} 的片段
        for match in reversed(list(re.finditer(r'"label"\s*:\s*([01])', response_text))):
            return int(match.group(1))
    except Exception:
        pass

    # 3. 回退到 YES/NO
    text = response_text.upper()
    last_words = text.split()[-20:]
    if "YES" in last_words:
        return 1
    if "NO" in last_words:
        return 0
    if "YES" in text:
        return 1
    if "NO" in text:
        return 0

    raise ValueError(f"Cannot extract label from response: {response_text[:200]}")


def main():
    parser = argparse.ArgumentParser(
        description="alive-buddy 自动化数据蒸馏脚本：用 LLM 生成贴合项目情境的 Proactive 训练数据。"
    )
    parser.add_argument(
        "-n", "--num-samples",
        type=int,
        default=10,
        help="要生成的样本数量（默认 10）"
    )
    parser.add_argument(
        "--data-path",
        type=str,
        default=os.path.join(os.path.dirname(__file__), "../../data/training_data.csv"),
        help="训练数据保存路径"
    )
    parser.add_argument(
        "--no-train",
        action="store_true",
        help="生成数据后不自动训练模型"
    )
    args = parser.parse_args()

    NUM_SAMPLES = args.num_samples
    DATA_PATH = os.path.abspath(args.data_path)

    print(f"🚀 alive-buddy 数据蒸馏启动")
    print(f"   目标样本数: {NUM_SAMPLES}")
    print(f"   数据保存路径: {DATA_PATH}")
    print(f"   LLM 模型: {MODEL_NAME}")
    print("-" * 50)

    samples = []
    failed = 0

    for i in range(NUM_SAMPLES):
        state = generate_random_state()
        prompt = state_to_prompt(state)

        print(f"\n--- 样本 {i + 1}/{NUM_SAMPLES} ---")
        print(prompt.strip())

        response = call_llm_for_label(prompt)
        print(f"\n[LLM Response]:\n{response.strip()}")

        if response == "ERROR":
            print("  ❌ API 请求失败，跳过该样本。")
            failed += 1
            continue

        try:
            target = extract_label(response)
            print(f"  -> 提取标签: {target}")

            # 保存到数据中，移除 prompt 专用的叙事字段
            sample_data = {k: v for k, v in state.items() if not k.startswith("_")}
            sample_data["target"] = target
            samples.append(sample_data)
        except ValueError as e:
            print(f"  ❌ {e}")
            failed += 1
            continue

    # 保存数据
    if samples:
        os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
        df = pd.DataFrame(samples)

        # 如果文件存在，则追加；否则创建
        if os.path.exists(DATA_PATH):
            df.to_csv(DATA_PATH, mode='a', header=False, index=False)
            print(f"\n✅ 追加 {len(samples)} 条数据到 {DATA_PATH}")
        else:
            df.to_csv(DATA_PATH, index=False)
            print(f"\n✅ 创建并保存 {len(samples)} 条数据到 {DATA_PATH}")

        # 可选：自动训练模型
        if not args.no_train:
            from model import ProactiveModel
            MODEL_PATH = os.path.join(os.path.dirname(__file__), "proactive_model.pkl")
            pm = ProactiveModel(MODEL_PATH)

            full_df = pd.read_csv(DATA_PATH)
            print(f"📦 开始基于 {len(full_df)} 条数据训练决策树...")
            pm.train(full_df)
            print("🎉 训练完成！")

    if failed:
        print(f"⚠️ 失败样本数: {failed}")

    if not samples:
        print("❌ 未生成任何有效样本。")


if __name__ == "__main__":
    main()
