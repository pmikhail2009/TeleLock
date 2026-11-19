import { Registry } from './registry.mjs';
import { clientServer } from './http.mjs';
import { sendText, startTelegram } from './telegram.mjs';
import { MatchDelivery } from './delivery.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('Задайте TELEGRAM_BOT_TOKEN в окружении сервера');
const registry = new Registry(process.env.KATKA_DATABASE || 'katka.sqlite');
const abort = new AbortController();
const send = (chat, text) => sendText(token, chat, text);
const matches = new MatchDelivery(registry, send);
const server = clientServer(registry, send, matches);
const port = Number(process.env.KATKA_PORT || process.env.PORT || 8787);
const host = process.env.KATKA_HOST || '127.0.0.1';
const workers = [];
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log('KATKA принимает подключения на порту', server.address().port);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  workers.push(matches.retryUntilStopped(abort.signal));
  if (!process.env.KATKA_CLOUD_SECRET) workers.push(startTelegram(registry, token, abort.signal));
  await Promise.race(workers);
} finally {
  abort.abort();
  await Promise.allSettled(workers);
  if (server.listening) await new Promise(resolve => server.close(resolve));
  registry.db.close();
}
