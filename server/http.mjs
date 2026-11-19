import { createServer } from 'node:http';
import { MatchDelivery } from './delivery.mjs';
import { servePanel } from './panel.mjs';
import { cloudCommand } from './cloud.mjs';

async function readObject(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Требуется JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Требуется объект');
  return data;
}

export function clientServer(registry, send, matches = new MatchDelivery(registry, send)) {
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url?.split('?')[0] === '/panel') return servePanel(res);
    const panelOrigin = process.env.KATKA_PANEL_ORIGIN;
    if (panelOrigin && req.url?.startsWith('/v1/') && req.headers.origin === panelOrigin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
    }
    if (req.method !== 'POST') return reply(405, { error: 'Требуется POST' });
    if (req.url === '/service/command') {
      try {
        const update = await readObject(req);
        const response = cloudCommand(registry, process.env.KATKA_CLOUD_SECRET, req.headers.authorization, update);
        return reply(200, { reply: response });
      } catch {
        return reply(403, { error: 'Запрос службы отклонён' });
      }
    }
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return reply(401, { error: 'Неверный ключ установки' });
    let notice;
    let result = { ok: true };
    try {
      const body = await readObject(req);
      const generation = body.generation;
      switch (req.url) {
        case '/v1/bind': {
          if (typeof body.code !== 'string') throw new Error('Введите код');
          const binding = registry.bind(token, body.code);
          result = { generation: binding.generation };
          notice = [binding.chat, 'Telegram подключён к KATKA.'];
          break;
        }
        case '/v1/status':
          result = registry.status(token) ?? { generation: null };
          break;
        case '/v1/unlink':
          registry.unlink(token, generation);
          break;
        case '/v1/test':
          notice = [registry.owner(token, generation), '🎮 Проверка KATKA. Уведомления подключены.'];
          break;
        case '/v1/poll':
          if (!Number.isSafeInteger(body.ack ?? 0) || (body.ack ?? 0) < 0) throw new Error('Неверное подтверждение');
          result = { command: registry.next(token, generation, body.ack ?? 0) };
          break;
        case '/v1/match': {
          const job = registry.recordMatch(token, generation, body.match);
          const outcome = await matches.deliver(job);
          if (outcome.delivery === 'pending') return reply(202, { ok: false, ...outcome });
          if (outcome.delivery === 'unknown') return reply(502, {
            ok: false, ...outcome, error: 'Telegram не подтвердил доставку. Повторная отправка может создать дубликат.'
          });
          if (outcome.delivery === 'rejected') return reply(502, {
            ok: false, ...outcome, error: 'Telegram отклонил уведомление.'
          });
          if (outcome.delivery === 'previous_binding') return reply(409, {
            ok: false, ...outcome, error: 'Матч зарегистрирован при другой привязке.'
          });
          return reply(200, { ok: true, ...outcome });
        }
        default:
          return reply(404, { error: 'Неизвестный адрес' });
      }
    } catch (error) {
      return reply(400, { error: error.message });
    }
    if (notice) {
      try {
        await send(...notice);
      } catch {
        return reply(502, { error: 'Telegram не подтвердил доставку' });
      }
    }
    reply(200, result);
  });
  return server;
}
