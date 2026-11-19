import { fetch } from 'sdk';
import { gateway, secret } from '../lib/config.js';
import { pairingForOwner } from '../lib/pairing.js';

export default async function (input, ctx) {
  const owner = ctx.initData.user.id;
  const row = await pairingForOwner(owner);
  if (!row || !/^[0-9a-f]{64}$/.test(row.installation)) return { connected: false };
  if (!gateway) throw new Error('Сервис подключения недоступен');
  const response = await fetch(gateway + '/service/status', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation: row.installation }),
  });
  if (!response.ok) throw new Error('Не удалось проверить привязку');
  const state = await response.json();
  return { connected: state.generation === row.generation };
}
