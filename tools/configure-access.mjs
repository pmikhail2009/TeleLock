import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';

const folder = new URL('../build/access/', import.meta.url);
await mkdir(folder, { recursive: true });
// Re-running preserves the existing credentials.
const credentialsFile = new URL('passwords.json', folder);
let credentials;
try { credentials = JSON.parse(await readFile(credentialsFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  credentials = { owner: 'KATKA-Owner-' + randomBytes(16).toString('hex'),
    test: 'KATKA-Test-' + randomBytes(16).toString('hex') };
  await writeFile(credentialsFile, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx' });
}
const hash = value => createHash('sha256').update(value).digest('hex');
await writeFile(new URL('worker-secrets.json', folder), JSON.stringify({
  KATKA_OWNER_PASSWORD_HASH: hash(credentials.owner),
  KATKA_TEST_PASSWORD_HASH: hash(credentials.test),
}, null, 2) + '\n');
await writeFile(new URL('Пароли.txt', folder),
  'Личный пароль владельца: ' + credentials.owner + '\n\n' +
  'Общий пароль преподавателя и тестировщиков: ' + credentials.test + '\n\n' +
  'Отправьте пароль отдельным сообщением в личный чат с ботом.\n' +
  'Повторно отправьте тот же пароль, чтобы вернуться к бесплатной версии.\n' +
  'Личный пароль закрепляется за первым вошедшим аккаунтом; тестовый подходит нескольким людям.\n' +
  'Эти пароли начнут работать после публикации обновлённого бота и загрузки worker-secrets.json на сервер.\n');
console.log('Пароли подготовлены в build/access/Пароли.txt. На сервер загружаются только хеши.');
