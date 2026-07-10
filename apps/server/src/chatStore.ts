import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatSession {
  id: string;
  user: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: ChatRole;
  content: string;
  tool_name: string | null;
  tool_call_id: string | null;
  metadata_json: string | null;
  created_at: number;
}

export class ChatStore {
  readonly db: Database.Database;

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
        ON chat_sessions (user, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages (session_id, id ASC);
    `);
  }

  createSession(input: { user: string; title?: string; now?: number }): ChatSession {
    const now = input.now ?? Date.now();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, user, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.user, input.title?.trim() || 'New Chat', now, now);
    return this.getSession(id)!;
  }

  getSession(id: string): ChatSession | undefined {
    return this.db
      .prepare(`SELECT * FROM chat_sessions WHERE id = ?`)
      .get(id) as ChatSession | undefined;
  }

  listSessions(user: string): ChatSession[] {
    return this.db
      .prepare(`SELECT * FROM chat_sessions WHERE user = ? ORDER BY updated_at DESC`)
      .all(user) as ChatSession[];
  }

  addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    toolName?: string;
    toolCallId?: string;
    metadata?: unknown;
    now?: number;
  }): ChatMessage {
    const now = input.now ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO chat_messages
           (session_id, role, content, tool_name, tool_call_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.role,
        input.content,
        input.toolName ?? null,
        input.toolCallId ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        now,
      );
    this.db
      .prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`)
      .run(now, input.sessionId);
    return this.db
      .prepare(`SELECT * FROM chat_messages WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as ChatMessage;
  }

  messages(sessionId: string): ChatMessage[] {
    return this.db
      .prepare(`SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC`)
      .all(sessionId) as ChatMessage[];
  }

  close(): void {
    this.db.close();
  }
}
