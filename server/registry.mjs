import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const digest = value => createHash('sha256').update(value).digest('hex');
export const MATCH_MESSAGE = '🎮 Матч найден! Возвращайся в Deadlock';
export const COMMANDS = new Set(['/play_normal', '/play_ranked', '/play_street', '/cancel', '/watch_black']);

// The installation generates a persistent, random 32-byte bearer credential.
// Only its fingerprint is stored. Never trust a client-supplied chat ID.
export class Registry {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, chat TEXT UNIQUE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(client TEXT PRIMARY KEY, chat TEXT UNIQUE, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT, generation TEXT NOT NULL, action TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matches(client TEXT NOT NULL, match TEXT NOT NULL, generation TEXT,
        delivery TEXT NOT NULL DEFAULT 'unknown', retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(client,match));
    `);
    this.atomic(() => {
      // Earlier releases only recorded an attempted send. Its outcome is irrecoverable.
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('matches') WHERE name='delivery'").get()) {
        this.db.exec(`ALTER TABLE matches ADD COLUMN generation TEXT;
          ALTER TABLE matches ADD COLUMN delivery TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE matches ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS match_retries ON matches(retry_at) WHERE delivery='pending'");
    });
  }

  atomic(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  issue(chat) {
    if (!/^[1-9]\d{0,18}$/.test(chat)) throw new Error('Требуется личный чат');
    const code = randomBytes(8).toString('hex').toUpperCase();
    this.atomic(() => {
      this.db.prepare('DELETE FROM codes WHERE chat=? OR expires<=?').run(chat, Date.now());
      this.db.prepare('INSERT INTO codes VALUES(?,?,?)').run(digest(code), chat, Date.now() + 600000);
    });
    return code;
  }

  clientKey(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Неверный ключ установки');
    return digest(token);
  }

  bind(token, code) {
    const client = this.clientKey(token);
    return this.atomic(() => {
      const row = this.db.prepare('DELETE FROM codes WHERE hash=? AND expires>? RETURNING chat')
        .get(digest(code.trim().toUpperCase()), Date.now());
      if (!row) throw new Error('Код неверен или истёк');
      this.db.prepare('DELETE FROM commands WHERE generation IN (SELECT generation FROM bindings WHERE chat=? OR client=?)').run(row.chat, client);
      this.db.prepare('DELETE FROM bindings WHERE chat=? OR client=?').run(row.chat, client);
      const generation = randomBytes(16).toString('hex');
      this.db.prepare('INSERT INTO bindings VALUES(?,?,?)').run(client, row.chat, generation);
      return { chat: row.chat, generation };
    });
  }

  status(token) {
    return this.db.prepare('SELECT generation FROM bindings WHERE client=?').get(this.clientKey(token)) ?? null;
  }

  owner(token, generation) {
    const row = this.db.prepare('SELECT chat FROM bindings WHERE client=? AND generation=?').get(this.clientKey(token), generation);
    if (!row) throw new Error('Привязка недействительна');
    return row.chat;
  }

  unlink(token, generation) {
    this.atomic(() => {
      this.owner(token, generation);
      this.db.prepare('DELETE FROM commands WHERE generation=?').run(generation);
      this.db.prepare('DELETE FROM bindings WHERE generation=?').run(generation);
    });
  }

  enqueue(chat, action) {
    if (!COMMANDS.has(action)) throw new Error('Неизвестная команда');
    this.atomic(() => {
      this.db.prepare('DELETE FROM commands WHERE expires<=?').run(Date.now());
      const result = this.db.prepare('INSERT INTO commands(generation,action,expires) SELECT generation,?,? FROM bindings WHERE chat=?')
        .run(action, Date.now() + 30000, chat);
      if (!result.changes) throw new Error('Сначала подключите Telegram в игре');
    });
  }

  next(token, generation, ack = 0) {
    return this.atomic(() => {
      this.owner(token, generation);
      this.db.prepare('DELETE FROM commands WHERE generation=? AND id=?').run(generation, ack);
      return this.db.prepare('SELECT id, action FROM commands WHERE generation=? AND expires>? ORDER BY id LIMIT 1').get(generation, Date.now()) ?? null;
    });
  }

  recordMatch(token, generation, match) {
    if (typeof match !== 'string' || !/^[1-9]\d{0,19}$/.test(match)) throw new Error('Неверный номер матча');
    return this.atomic(() => {
      this.owner(token, generation);
      const client = this.clientKey(token);
      this.db.prepare("INSERT OR IGNORE INTO matches(client, match, generation, delivery) VALUES(?,?,?,'pending')")
        .run(client, match, generation);
      return { client, match, generation };
    });
  }

  reserveDelivery({ client, match, generation }) {
    return this.atomic(() => {
      const row = this.db.prepare(`SELECT m.generation, m.delivery, m.retry_at, b.chat FROM matches m
        LEFT JOIN bindings b ON m.client=b.client AND m.generation=b.generation
        WHERE m.client=? AND m.match=?`).get(client, match);
      if (!row?.generation) return { delivery: 'unknown' };
      if (row.generation !== generation || !row.chat) return { delivery: 'previous_binding' };
      if (row.delivery !== 'pending') return { delivery: row.delivery };
      if (row.retry_at > Date.now()) return { delivery: 'pending', retryAt: row.retry_at };
      // A crash after this commit might happen before or after Telegram receives the call.
      this.db.prepare("UPDATE matches SET delivery='unknown', retry_at=0 WHERE client=? AND match=?").run(client, match);
      return { chat: row.chat };
    });
  }

  finishDelivery({ client, match, generation }, delivery, retryAt = 0) {
    this.db.prepare(`UPDATE matches SET delivery=?,retry_at=? WHERE client=? AND match=?
      AND generation=? AND delivery='unknown'`).run(delivery, retryAt, client, match, generation);
  }

  dueDeliveries() {
    return this.db.prepare(`SELECT m.client, m.match, m.generation FROM matches m JOIN bindings b
      ON m.client=b.client AND m.generation=b.generation WHERE m.delivery='pending' AND m.retry_at<=?
      ORDER BY m.retry_at LIMIT 32`).all(Date.now());
  }
}
