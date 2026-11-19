import { EndpointError } from 'sdk';
import { redeemCode, pairingForOwner } from '../lib/pairing.js';

export default async function (input, ctx) {
  const owner = ctx?.initData?.user?.id;
  if (!Number.isSafeInteger(owner) || owner <= 0 ||
      typeof input?.code !== 'string' || !/^[A-F0-9]{16}$/.test(input.code) ||
      typeof input?.installation !== 'string' || !/^[a-f0-9]{64}$/.test(input.installation)) {
    throw new EndpointError('Неверный запрос подключения', { code: 'INVALID_PAIRING' });
  }
  await redeemCode(owner, input.code, input.installation);
  const binding = await pairingForOwner(owner);
  if (binding?.redeemed_code !== input.code || binding.installation !== input.installation ||
      !/^[a-f0-9]{32}$/.test(binding.generation) ||
      !Number.isSafeInteger(binding.revision) || binding.revision <= 0) {
    throw new EndpointError('Код неверен, истёк или привязка изменилась', { code: 'INVALID_PAIRING' });
  }
  return { generation: binding.generation, revision: binding.revision };
}
