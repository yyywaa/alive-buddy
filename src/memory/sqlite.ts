import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// 每个 Character 独立一个 SQLite 数据库实例
const dbInstances = new Map<string, DatabaseType>();

/**
 * 初始化指定 Character 的 SQLite 数据库
 * 默认存储路径：data/characters/{character_id}/memory.db
 */
export function initSQLite(characterId: string, dbPath?: string): DatabaseType {
  if (dbInstances.has(characterId)) {
    return dbInstances.get(characterId)!;
  }

  const baseDir = process.env.ALIVE_BUDDY_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const defaultPath = path.join(baseDir, 'characters', characterId, 'memory.db');
  const targetPath = dbPath || defaultPath;

  // 确保目录存在
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(targetPath);

  // 开启 WAL 模式以提升并发读写性能
  db.pragma('journal_mode = WAL');

  // 初始化核心表（按 Character 隔离后，session_id 仍保留用于区分同一 Character 下的不同会话）
  db.exec(`
    -- 1. 运行时状态表
    CREATE TABLE IF NOT EXISTS runtime_states (
      character_id TEXT PRIMARY KEY,
      mood INTEGER DEFAULT 0,
      energy INTEGER DEFAULT 100,
      boredom INTEGER DEFAULT 0,
      last_interaction_at INTEGER,
      is_active BOOLEAN DEFAULT 1
    );

    -- 2. 感知层消息表 (完整 JSON 对象存储)
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE NOT NULL,
      character_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL
    );

    -- 3. 事件层剧情总结表 (L2)
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 4. 多模态媒体索引表 (用于快速定位最后 N 张图片)
    CREATE TABLE IF NOT EXISTS media_registry (
      msg_id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);

  // 为常用的查询创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_character_session ON messages(character_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_character_timestamp ON messages(character_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_episodes_character_session ON episodes(character_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_media_character_session_time ON media_registry(character_id, session_id, timestamp);
  `);

  dbInstances.set(characterId, db);
  return db;
}

/**
 * 获取指定 Character 的数据库实例
 */
export function getDB(characterId: string): DatabaseType {
  const db = dbInstances.get(characterId);
  if (!db) {
    throw new Error(`SQLite not initialized for character ${characterId}. Call initSQLite(characterId) first.`);
  }
  return db;
}

/**
 * 关闭指定 Character 的数据库连接（可选，用于优雅退出）
 */
export function closeSQLite(characterId: string): void {
  const db = dbInstances.get(characterId);
  if (db) {
    db.close();
    dbInstances.delete(characterId);
  }
}
