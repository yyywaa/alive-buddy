import { ChromaClient, Collection } from 'chromadb';

let client: ChromaClient | null = null;
let collection: Collection | null = null;

/**
 * 初始化 ChromaDB 连接与 Collection
 * 默认连接本地的 ChromaDB 服务 (通常为 http://localhost:8000)
 */
export async function initChroma(url: string = "http://localhost:8000") {
  if (client) return;

  try {
    client = new ChromaClient({ path: url });
    
    // 获取或创建用于存储长期印象的 Collection
    collection = await client.getOrCreateCollection({
      name: "alive_buddy_impressions",
      metadata: { "hnsw:space": "cosine" } // 使用余弦相似度
    });
    
    console.log(`[DEBUG] [ChromaDB] Successfully initialized collection: alive_buddy_impressions`);
  } catch (error) {
    console.error(`[ERROR] [ChromaDB] Failed to initialize. Is ChromaDB running at ${url}?`, error);
    throw error;
  }
}

/**
 * 添加一条长期印象到向量数据库
 * 
 * @param sessionId 会话标识符，用于隔离不同环境的记忆
 * @param content 提炼出的绝对事实（如："用户非常喜欢猫"）
 */
export async function addImpression(sessionId: string, content: string) {
  if (!collection) throw new Error("ChromaDB not initialized. Call initChroma() first.");
  
  const id = `impression-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  
  await collection.add({
    ids: [id],
    metadatas: [{ session_id: sessionId, timestamp: Date.now() }],
    documents: [content]
  });
}

/**
 * 通过语义检索相关的长期印象
 * 
 * @param sessionId 会话标识符
 * @param query 当前用户的提问或当前上下文，用于进行向量匹配
 * @param nResults 返回的最多条数
 * @returns 匹配到的历史事实文本数组
 */
export async function queryImpressions(sessionId: string, query: string, nResults: number = 3): Promise<string[]> {
  if (!collection) throw new Error("ChromaDB not initialized. Call initChroma() first.");

  const results = await collection.query({
    queryTexts: [query],
    nResults: nResults,
    where: { session_id: sessionId } // 只匹配当前会话的记忆
  });

  // results.documents 的结构是 string[][]，因为 queryTexts 是一个数组
  if (results.documents && results.documents.length > 0 && results.documents[0] !== null) {
    // 过滤掉可能出现的 null 值，确保返回类型安全
    return (results.documents[0] as Array<string | null>).filter((doc): doc is string => doc !== null);
  }
  
  return [];
}
