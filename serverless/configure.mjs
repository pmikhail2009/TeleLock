import { mkdir, readFile, writeFile } from 'node:fs/promises';
const gateway = new URL(process.env.KATKA_GATEWAY);
const secret = process.env.KATKA_CLOUD_SECRET;
if (gateway.protocol !== 'https:' || gateway.href !== gateway.origin + '/' || !/^[a-f0-9]{64}$/.test(secret ?? ''))
  throw new Error('Требуются KATKA_GATEWAY (HTTPS) и KATKA_CLOUD_SECRET (32 случайных байта, hex)');
const folder = new URL('./tgcloud/lib/', import.meta.url);
await mkdir(folder, { recursive: true });
await writeFile(new URL('config.js', folder),
  'export const gateway = ' + JSON.stringify(gateway.origin) + ';\nexport const secret = ' + JSON.stringify(secret) + ';\n',
  { mode: 0o600 });
const output = new URL('./dist/', import.meta.url);
await mkdir(output, { recursive: true });
const panel = await readFile(new URL('../mod/panel/index.html', import.meta.url), 'utf8');
await writeFile(new URL('index.html', output), panel.replace(
  '<meta name="katka-gateway" content="">',
  '<meta name="katka-gateway" content="' + gateway.origin + '">'
));
