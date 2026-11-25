import { staffAccess } from './access.mjs';
import { feedbackMaxLength, feedbackMessage } from '../serverless/tgcloud/lib/controls.js';

const ratingKey = owner => 'feedback:rating:' + owner;
const totalsKey = 'feedback:totals';
const textPrefix = 'feedback:text:';
const pageSize = 3;
const launchesBeforePrompt = 5;
const emptyCounts = () => [0, 0, 0, 0, 0];

export const feedback = {
  async recordFeedbackLaunch(storage, owner) {
    const key = 'feedback:launches:' + owner;
    const launches = await storage.get(key) || 0;
    if (launches >= launchesBeforePrompt) return;
    await storage.put(key, launches + 1);
    if (launches + 1 === launchesBeforePrompt && !await storage.get(ratingKey(owner))) {
      await this.storeTask(storage, 'feedback:' + owner, { kind: 'feedback', owner, at: Date.now() + 2000 });
    }
  },

  async requestFeedback(owner) {
    if (!this.botToken || await this.storage.get(ratingKey(owner))) return;
    await this.telegram('sendMessage', { chat_id: owner, ...feedbackMessage(await this.language(owner)) });
  },

  async handleFeedback(owner, { operation, value, text, date, id, cursor } = {}) {
    if (!Number.isSafeInteger(owner) || owner <= 0) return Response.json({}, { status: 400 });
    const language = await this.language(owner);
    if (operation === 'open') {
      return Response.json({ language, rating: await this.storage.get(ratingKey(owner)) || null });
    }
    if (operation === 'rate') {
      if (!Number.isInteger(value) || value < 1 || value > 5)
        return Response.json({}, { status: 400 });
      const rating = await this.storage.transaction(async tx => {
        const key = ratingKey(owner);
        const saved = await tx.get(key);
        if (saved) return saved;
        const counts = await tx.get(totalsKey) || emptyCounts();
        counts[value - 1]++;
        await tx.put(totalsKey, counts);
        await tx.put(key, value);
        return value;
      });
      return Response.json({ language, rating });
    }
    if (operation === 'write') {
      if (typeof text !== 'string' || !text.trim() || text.trim().length > feedbackMaxLength ||
          !Number.isSafeInteger(date) || date <= 0 || date > 9999999999 ||
          !Number.isSafeInteger(id) || id < 0)
        return Response.json({}, { status: 400 });
      // Telegram's update ID makes retries idempotent. The timestamp sorts newer reviews first.
      const position = String(9999999999 - date).padStart(10, '0') + ':' + String(id).padStart(16, '0');
      await this.storage.put(textPrefix + position, text.trim());
      return Response.json({ language, saved: true });
    }
    if (operation === 'list') {
      if (!staffAccess(await this.tier(owner))) return Response.json({ language, denied: true }, { status: 403 });
      if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{10}:\d{16}$/.test(cursor)))
        return Response.json({}, { status: 400 });
      const [counts, rows] = await Promise.all([
        this.storage.get(totalsKey),
        this.storage.list({ prefix: textPrefix, limit: pageSize + 1, ...(cursor ? { startAfter: textPrefix + cursor } : {}) }),
      ]);
      const page = [...rows].slice(0, pageSize);
      const next = rows.size > pageSize ? page.at(-1)[0].slice(textPrefix.length) : null;
      return Response.json({ language, counts: counts || emptyCounts(), texts: page.map(([, body]) => body), next });
    }
    return Response.json({}, { status: 400 });
  },
};
