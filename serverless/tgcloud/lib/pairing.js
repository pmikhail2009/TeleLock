import { db } from 'sdk';
import { sql } from 'sdk/db';

export async function issueCode(owner) {
  const result = await db.run(sql`
    INSERT INTO katka_bindings(owner, installation, generation, pending_code, code_expires)
    VALUES (${owner}, ${'pending:' + owner}, lower(hex(randomblob(16))),
            upper(hex(randomblob(8))), ${Date.now() + 600000})
    ON CONFLICT(owner) DO UPDATE SET pending_code=excluded.pending_code, code_expires=excluded.code_expires
    RETURNING pending_code AS code
  `);
  return result.rows[0].code;
}

export async function redeemCode(owner, code, installation) {
  if (typeof installation !== 'string' || !/^[0-9a-f]{64}$/.test(installation)) return null;
  const result = await db.run(sql`
    UPDATE OR REPLACE katka_bindings
    SET installation=${installation}, generation=lower(hex(randomblob(16))),
        revision=(SELECT coalesce(max(revision), 0) + 1 FROM katka_bindings),
        redeemed_code=pending_code, pending_code=NULL, code_expires=NULL
    WHERE owner=${owner} AND pending_code=${code} AND code_expires>${Date.now()}
    RETURNING generation
  `);
  return result.rows[0]?.generation ?? null;
}

export async function pairingForOwner(owner) {
  const result = await db.get(sql`
    SELECT installation, generation, pending_code, redeemed_code, revision
    FROM katka_bindings WHERE owner=${owner}
  `);
  return result ?? null;
}
