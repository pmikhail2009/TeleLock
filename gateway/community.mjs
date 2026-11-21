import { communityIdPattern, communityMaxLength } from '../serverless/tgcloud/lib/community.js';

const knownPrefix = 'community:known:';
const inboxPrefix = 'community:inbox:';
const deletedPrefix = 'community:deleted:';
const pageSize = 3;

export const community = {
  async communityPage(prefix, cursor) {
    const rows = await this.storage.list({ prefix, limit: pageSize + 1,
      ...(cursor ? { startAfter: prefix + cursor } : {}) });
    const entries = [...rows].slice(0, pageSize).map(([key, entry]) => ({ ...entry, id: key.slice(prefix.length) }));
    return { entries, next: rows.size > pageSize ? entries.at(-1).id : null };
  },

  async handleCommunity(owner, { operation, text, date, id, cursor } = {}) {
    if (!Number.isSafeInteger(owner) || owner <= 0) return Response.json({}, { status: 400 });
    const language = 'ru';
    const tier = await this.tier(owner);
    const admin = tier === 'owner';
    const denied = () => Response.json({ language, denied: true }, { status: 403 });
    const invalid = () => Response.json({ language }, { status: 400 });
    if (operation === 'home') return Response.json({ language, admin });
    if (['add', 'delete', 'inbox'].includes(operation) && !admin) return denied();
    if (operation === 'known' || operation === 'inbox') {
      if (cursor !== undefined && (typeof cursor !== 'string' || !communityIdPattern.test(cursor))) return invalid();
      const page = await this.communityPage(operation === 'known' ? knownPrefix : inboxPrefix, cursor);
      return Response.json({ language, admin, ...page });
    }
    if (operation === 'delete') {
      if (typeof id !== 'string' || !communityIdPattern.test(id)) return invalid();
      const allowed = await this.storage.transaction(async tx => {
        if (await this.tier(owner, tx) !== 'owner') return false;
        if (await tx.get(knownPrefix + id)) {
          await tx.put(deletedPrefix + id, true);
          await tx.delete(knownPrefix + id);
        }
        return true;
      });
      if (!allowed) return denied();
      return Response.json({ language, admin, ...await this.communityPage(knownPrefix) });
    }
    if (!['add', 'suggestion', 'report'].includes(operation) || typeof text !== 'string' ||
        !text.trim() || text.trim().length > communityMaxLength ||
        !Number.isSafeInteger(date) || date <= 0 || date > 9999999999 || !Number.isSafeInteger(id) || id < 0)
      return invalid();
    // Sort newest first and use the Telegram update ID so delivery retries cannot create duplicates.
    const position = String(9999999999 - date).padStart(10, '0') + ':' +
      String(Number.MAX_SAFE_INTEGER - id).padStart(16, '0');
    const entry = { operation, text: text.trim() };
    const allowed = await this.storage.transaction(async tx => {
      const key = (operation === 'add' ? knownPrefix : inboxPrefix) + position;
      if (operation === 'add') {
        if (await this.tier(owner, tx) !== 'owner') return false;
        if (await tx.get(deletedPrefix + position)) return true;
      }
      if (!await tx.get(key)) await tx.put(key, entry);
      return true;
    });
    if (!allowed) return denied();
    return Response.json({ language, saved: true });
  },
};
