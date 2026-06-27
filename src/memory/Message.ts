import { UnifiedMessage } from '../api/types';

/**
 * 封装后的领域对象，屏蔽了多模态内容的组装细节。
 */
export class Message {
  constructor(public data: UnifiedMessage) {}

  /**
   * 判断这条消息是否包含多模态媒体内容
   */
  hasMedia(): boolean {
    return this.data.payload.content.some(item => item.type === 'image_url');
  }

  /**
   * 转换为可直接喂给 OpenAI/LLM 的 payload 格式。
   * 
   * @param keepImage 如果为 true，则保留图片的 url 对象；
   *                  如果为 false，则强制将其降级为 text 的 summary 描述。
   */
  toOpenAIPayload(keepImage: boolean) {
    const content = this.data.payload.content.map(item => {
      // 遇到图片类型的区块
      if (item.type === 'image_url') {
        if (keepImage) {
          // 保留原始的结构供视觉模型读取
          return item;
        } else {
          // 降级为文本占位符，参与上下文组装和总结
          const desc = item.summary ? item.summary : '无法获取描述';
          return { type: 'text', text: `*[附加媒体] 用户展示了一张图片：${desc}*` };
        }
      }
      
      // 其他类型（如文本）原样返回
      return item;
    });

    return {
      role: this.data.payload.role,
      content
    };
  }

  /**
   * 序列化为 JSON 字符串，供写入数据库 payload 字段
   */
  toJSONString(): string {
    return JSON.stringify(this.data);
  }

  /**
   * 从数据库 payload 字段反序列化出 Message 对象
   */
  static fromJSONString(jsonStr: string): Message {
    const data = JSON.parse(jsonStr) as UnifiedMessage;
    return new Message(data);
  }
}
