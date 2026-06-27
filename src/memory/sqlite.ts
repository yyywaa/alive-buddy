import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: DatabaseType | null = null;

export function initSQLite(dbPath?: string): DatabaseType {
  if (db) return db;

  // 默认将数据库保存在项目根目录的 data 文件夹下
  const defaultPath = path.resolve(process.cwd(), 'data/alive_buddy.db');
  const targetPath = dbPath || defaultPath;

  // 确保目录存在
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(targetPath);
  
  // 开启 WAL 模式以提升并发读写性能
  db.pragma('journal_mode = WAL');

  // 初始化核心表
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
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL
    );

    -- 3. 事件层剧情总结表 (L2)
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 4. 多模态媒体索引表 (用于快速定位最后 N 张图片)
    CREATE TABLE IF NOT EXISTS media_registry (
      msg_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);

  // 为常用的查询创建索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_media_session_time ON media_registry(session_id, timestamp);
  `);

  return db;
}

export function getDB(): DatabaseType {
  if (!db) {
    throw new Error("SQLite not initialized. Call initSQLite() first.");
  }
  return db;
}
