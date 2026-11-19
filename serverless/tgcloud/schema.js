import { table, integer, text, uniqueIndex } from 'sdk/db';

export const bindings = table('katka_bindings', {
  installation: text('installation').primaryKey(),
  owner: integer('owner').notNull().unique(),
  generation: text('generation').notNull().unique(),
  pendingCode: text('pending_code'),
  redeemedCode: text('redeemed_code'),
  revision: integer('revision'),
  codeExpires: integer('code_expires'),
}, t => ({
  pendingCodeIndex: uniqueIndex('katka_pending_code_unique').on(t.pendingCode),
}));

export const codes = table('katka_codes', {
  owner: integer('owner').primaryKey(),
  code: text('code').notNull().unique(),
  expires: integer('expires').notNull(),
});
