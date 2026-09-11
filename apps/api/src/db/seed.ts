import { isValidLinkCode } from '@kobolink/contracts'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { pathToFileURL } from 'node:url'
import * as schema from './schema/index.js'

/**
 * `npm run db:seed -w apps/api`. Populates one merchant so B2-B5 (auth,
 * links, checkout) have something to develop and demo against without each
 * writing their own bootstrap data. Reads `DATABASE_URL` from the
 * environment — same convention as `drizzle.config.ts`, no fallback
 * connection string checked into source.
 *
 * Idempotent by construction: every write is find-or-create against a
 * unique key the schema already enforces (`users.email`,
 * `(ledger_accounts.owner_user_id, kind)`, `links.code`), so running this
 * twice — the B1 done-when — leaves exactly one merchant, one
 * `merchant_receivable` account and the same two links, never duplicates.
 */

export const SEED_MERCHANT_EMAIL = 'merchant@kobolink.dev'
const SEED_MERCHANT_DISPLAY_NAME = 'Adebayo Stores'
const SEED_MERCHANT_PHONE = '+2348031234567'

/**
 * B2 (not yet built) owns argon2id password hashing. This is deliberately
 * not a hash of any real password — the seeded merchant cannot log in
 * until B2 lands. B1's own done-when only needs the NOT NULL column
 * satisfied; making that up front instead of leaving it blank means B2
 * does not also have to backfill this row.
 */
const SEED_PASSWORD_PLACEHOLDER_HASH = 'unset$b1-seed-placeholder-no-real-password-until-b2'

const SEED_LINK_FIXED_CODE = 'KBLDEMX2'
const SEED_LINK_OPEN_CODE = 'KBLDEMX3'

for (const code of [SEED_LINK_FIXED_CODE, SEED_LINK_OPEN_CODE]) {
  if (!isValidLinkCode(code)) {
    throw new Error(`seed: "${code}" is not a valid link code per @kobolink/contracts' isValidLinkCode`)
  }
}

type SeedDb = ReturnType<typeof drizzle<typeof schema>>

export interface SeedResult {
  merchantUserId: string
  merchantReceivableAccountId: string
  linkCodes: string[]
}

async function findOrCreateMerchant(db: SeedDb): Promise<typeof schema.users.$inferSelect> {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, SEED_MERCHANT_EMAIL)).limit(1)
  if (existing !== undefined) return existing

  const [created] = await db
    .insert(schema.users)
    .values({
      role: 'merchant',
      email: SEED_MERCHANT_EMAIL,
      phone: SEED_MERCHANT_PHONE,
      passwordHash: SEED_PASSWORD_PLACEHOLDER_HASH,
      displayName: SEED_MERCHANT_DISPLAY_NAME,
    })
    // A concurrent seed run could lose the race between the select above
    // and this insert; falling back to a re-select on conflict keeps the
    // function idempotent under that race too, not only on a second
    // sequential run.
    .onConflictDoNothing({ target: schema.users.email })
    .returning()
  if (created !== undefined) return created

  const [afterConflict] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, SEED_MERCHANT_EMAIL))
    .limit(1)
  if (afterConflict === undefined) throw new Error('seed: merchant user find-or-create produced no row')
  return afterConflict
}

async function findOrCreateMerchantReceivable(
  db: SeedDb,
  merchantUserId: string,
): Promise<typeof schema.ledgerAccounts.$inferSelect> {
  const match = and(
    eq(schema.ledgerAccounts.ownerUserId, merchantUserId),
    eq(schema.ledgerAccounts.kind, 'merchant_receivable'),
  )

  const [existing] = await db.select().from(schema.ledgerAccounts).where(match).limit(1)
  if (existing !== undefined) return existing

  // `(owner_user_id, kind)` is a *partial* unique index (`WHERE owner_user_id
  // IS NOT NULL`, see ledger-accounts.ts), which ON CONFLICT can only
  // target by repeating its predicate. A plain insert-then-reselect avoids
  // that entirely and reads the same either way; this script is not meant
  // to run concurrently with itself, so the small race window is accepted
  // rather than engineered around.
  await db.insert(schema.ledgerAccounts).values({ ownerUserId: merchantUserId, kind: 'merchant_receivable' })

  const [created] = await db.select().from(schema.ledgerAccounts).where(match).limit(1)
  if (created === undefined) throw new Error('seed: merchant_receivable account find-or-create produced no row')
  return created
}

async function ensureLinks(db: SeedDb, merchantUserId: string): Promise<string[]> {
  await db
    .insert(schema.links)
    .values([
      {
        code: SEED_LINK_FIXED_CODE,
        merchantUserId,
        title: 'Consulting session',
        description: 'One hour, paid up front.',
        amountKobo: 500_000, // ₦5,000 — CreateLinkRequestSchema.amountKobo is kobo, never naira.
        isReusable: true,
      },
      {
        code: SEED_LINK_OPEN_CODE,
        merchantUserId,
        title: 'Support this stall',
        description: null,
        amountKobo: null, // the payer names the amount at checkout
        isReusable: true,
      },
    ])
    .onConflictDoNothing({ target: schema.links.code })

  return [SEED_LINK_FIXED_CODE, SEED_LINK_OPEN_CODE]
}

export async function seed(db: SeedDb): Promise<SeedResult> {
  const merchant = await findOrCreateMerchant(db)
  const account = await findOrCreateMerchantReceivable(db, merchant.id)
  const linkCodes = await ensureLinks(db, merchant.id)

  return {
    merchantUserId: merchant.id,
    merchantReceivableAccountId: account.id,
    linkCodes,
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy apps/api/.env.example to .env.local and export it, or run with dotenv-cli.',
    )
  }
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const db = drizzle(pool, { schema })
    const result = await seed(db)
    // eslint-disable-next-line no-console -- this file's whole purpose is a human-run CLI reporting what it did.
    console.info(
      `seeded merchant ${result.merchantUserId} (${SEED_MERCHANT_EMAIL}), ` +
        `account ${result.merchantReceivableAccountId}, links ${result.linkCodes.join(', ')}`,
    )
  } finally {
    await pool.end()
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
