import { timingSafeEqual } from 'node:crypto';
import { replyFor } from './telegram.mjs';

export function cloudCommand(registry, secret, authorization, update) {
  const provided = Buffer.from(authorization || '');
  const expected = Buffer.from('Bearer ' + secret);
  if (!/^[a-f0-9]{64}$/.test(secret ?? '') || provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)) throw new Error('Неверный ключ службы');
  if (!Number.isSafeInteger(update.id) || update.id < 0) throw new Error('Неверный номер команды');
  const db = registry.db;
  return registry.atomic(() => {
    db.exec('CREATE TABLE IF NOT EXISTS cloud_updates(id INTEGER PRIMARY KEY, expires INTEGER NOT NULL)');
    db.prepare('DELETE FROM cloud_updates WHERE expires<=?').run(Date.now());
    if (!db.prepare('INSERT OR IGNORE INTO cloud_updates VALUES(?,?)').run(update.id, Date.now()+172800000).changes) return null;
    return replyFor(registry, update.message);
  });
}
