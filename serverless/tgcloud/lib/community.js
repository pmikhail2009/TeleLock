import { labels } from './controls.js';

const localize = (language, en, ru) => language === 'ru' ? ru : en;

export const communityMaxLength = 1000;
export const communityIdPattern = /^\d{10}:\d{16}$/;
export const communityCallbackPattern = /^community:(home|suggestion|report|add|known|inbox|delete)(?::(\d{10}:\d{16}))?$/;

const prompts = {
  suggestion: ['Reply with your suggestion for improving Telelock (up to 1,000 characters).',
    'Ответьте на это сообщение и напишите, как можно улучшить Telelock (до 1000 символов).'],
  report: ['Reply with what happened and how to reproduce it (up to 1,000 characters).',
    'Ответьте на это сообщение и опишите, что произошло и как повторить проблему (до 1000 символов).'],
  add: ['Reply with the description to publish in Known Issues (up to 1,000 characters).',
    'Ответьте на это сообщение с описанием для публикации в разделе «Известные проблемы» (до 1000 символов).'],
};

export function communityReply(language, operation) {
  return { text: localize(language, ...prompts[operation]), reply_markup: { force_reply: true } };
}

export function communityReplyType(original) {
  if (!original?.from?.is_bot || original.forward_origin) return null;
  for (const [operation, [en, ru]] of Object.entries(prompts)) {
    if (original.text === en) return { operation, language: 'en' };
    if (original.text === ru) return { operation, language: 'ru' };
  }
  return null;
}

export function communityDenied(language) {
  return localize(language, 'This action requires admin access.', 'Это действие доступно только в режиме admin.');
}

export function communityConfirmation(language, operation) {
  if (operation === 'add') return {
    text: localize(language, 'The issue has been published.', 'Проблема опубликована.'),
    reply_markup: { inline_keyboard: [[{
      text: localize(language, '🐞 Known issues', '🐞 Известные проблемы'), callback_data: 'community:known',
    }]] },
  };
  const messages = {
    suggestion: ['Thank you! Your suggestion was sent to the admin.', 'Спасибо! Ваше предложение отправлено администратору.'],
    report: ['Thank you! Your report was sent to the admin.', 'Спасибо! Ваше сообщение о проблеме отправлено администратору.'],
  };
  return { text: localize(language, ...messages[operation]) };
}

export function communityMessage({ language, admin, entries = [], next, denied }, section = 'home') {
  const t = (en, ru) => localize(language, en, ru);
  if (denied) return { text: communityDenied(language), reply_markup: { inline_keyboard: [] } };
  const row = (en, ru, action) => [{ text: t(en, ru), callback_data: 'community:' + action }];
  const inbox = () => row('📥 User submissions', '📥 Обращения пользователей', 'inbox');
  const known = () => row('🐞 Known issues', '🐞 Известные проблемы', 'known');
  const message = (text, inline_keyboard) => ({ text, link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard } });
  if (section === 'home') {
    const rows = [row('💡 Suggest an improvement', '💡 Предложить улучшение', 'suggestion'), known()];
    if (admin) rows.push(inbox());
    return message(t('👥 Telelock Community Center', labels.community), rows);
  }
  const rows = [];
  const isKnown = section === 'known';
  const title = isKnown ? known()[0].text : inbox()[0].text;
  const lines = entries.map(({ operation, text }, index) => isKnown ? `${index + 1}. ${text}` :
    (operation === 'suggestion' ? t('💡 Suggestion', '💡 Предложение') : t('🐞 Problem report', '🐞 Сообщение о проблеме')) + '\n' + text);
  if (isKnown) {
    rows.push(row('🐞 Report a problem', '🐞 Сообщить о проблеме', 'report'));
    if (admin) {
      rows.push(row('➕ Add an issue', '➕ Добавить проблему', 'add'));
      entries.forEach(({ id }, index) => rows.push(row(`🗑 Delete issue ${index + 1}`, `🗑 Удалить проблему ${index + 1}`, 'delete:' + id)));
    }
  }
  if (next) rows.push(row('More', 'Показать ещё', section + ':' + next));
  rows.push(row('↩️ Community Center', '↩️ Центр сообщества', 'home'));
  const empty = isKnown ? t('No known issues yet.', 'Известных проблем пока нет.')
    : t('No submissions yet.', 'Обращений пока нет.');
  return message([title, ...(lines.length ? lines : [empty])].join('\n\n'), rows);
}
