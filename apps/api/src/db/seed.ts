import { hash } from '@node-rs/argon2'
import { isValidLinkCode } from '@kobolink/contracts'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import * as schema from './schema/index.js'

/**
 * `npm run db:seed -w apps/api`. Populates the fixtures B2-B5 (auth, links,
 * checkout) develop and demo against without each writing their own
 * bootstrap data: the `external_funding` singleton ledger account every
 * `link_payment`/`topup` posting needs as a counterparty, and — when a real
 * password is supplied — one merchant, their `merchant_receivable` account,
 * and two links. Reads `DATABASE_URL` from the environment — same
 * convention as `drizzle.config.ts`, no fallback connection string checked
 * into source.
 *
 * Idempotent by construction: every write is find-or-create against a
 * unique key the schema already enforces (`ledger_accounts.kind =
 * 'external_funding'`'s own singleton index, `users.email`,
 * `(ledger_accounts.owner_user_id, kind)`, `links.code`), so running this
 * twice — the B1 done-when — leaves exactly one of each, never duplicates.
 */

export const SEED_MERCHANT_EMAIL = 'merchant@kobolink.dev'
const SEED_MERCHANT_DISPLAY_NAME = 'Adebayo Stores'
const SEED_MERCHANT_PHONE = '+2348031234567'

const SEED_LINK_FIXED_CODE = 'KBLDEMX2'
const SEED_LINK_OPEN_CODE = 'KBLDEMX3'

for (const code of [SEED_LINK_FIXED_CODE, SEED_LINK_OPEN_CODE]) {
  if (!isValidLinkCode(code)) {
    throw new Error(`seed: "${code}" is not a valid link code per @kobolink/contracts' isValidLinkCode`)
  }
}

type SeedDb = ReturnType<typeof drizzle<typeof schema>>

export interface SeedResult {
  externalFundingAccountId: string
  /**
   * True when no `SEED_MERCHANT_PASSWORD` was available and the merchant
   * did not already exist from an earlier run — every `merchant*` field
   * below is then `null`. Review finding (B1 round 1): a placeholder
   * `password_hash` string is not a valid argon2id hash, so B2's login
   * (`argon2.verify(hash, password)`) would throw, not just reject, the
   * first time anyone tried the seeded merchant's password. A real hash of
   * an unknown password is the only alternative that is both truthful and
   * usable, and it has to come from somewhere the seed script does not
   * itself invent — hence the environment variable, and skipping rather
   * than fabricating one when it is absent.
   */
  skippedMerchant: boolean
  merchantUserId: string | null
  merchantReceivableAccountId: string | null
  linkCodes: string[] | null
}

async function findOrCreateExternalFunding(db: SeedDb): Promise<typeof schema.ledgerAccounts.$inferSelect> {
  const match = eq(schema.ledgerAccounts.kind, 'external_funding')

  const [existing] = await db.select().from(schema.ledgerAccounts).where(match).limit(1)
  if (existing !== undefined) return existing

  // Same reasoning as findOrCreateMerchantReceivable below: this is a
  // *partial* unique index, so a plain insert-then-reselect sidesteps
  // ON CONFLICT's predicate-matching requirement entirely.
  await db.insert(schema.ledgerAccounts).values({ ownerUserId: null, kind: 'external_funding' })

  const [created] = await db.select().from(schema.ledgerAccounts).where(match).limit(1)
  if (created === undefined) throw new Error('seed: external_funding account find-or-create produced no row')
  return created
}

async function findMerchant(db: SeedDb): Promise<typeof schema.users.$inferSelect | undefined> {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, SEED_MERCHANT_EMAIL)).limit(1)
  return existing
}

/** The subset of `pg`'s `DatabaseError` shape this file reads — `code` and `constraint` are set by Postgres itself for a unique-violation error, not invented by the driver. */
interface PossiblePgError {
  code?: string
  constraint?: string
  cause?: unknown
}

/**
 * `drizzle-orm`'s node-postgres driver never throws `pg`'s own
 * `DatabaseError` directly — it wraps it in a `DrizzleQueryError` whose
 * `message` is a generic "Failed query: ..." and whose `.cause` is the
 * real driver error carrying `code`/`constraint`. Unwrap `.cause`
 * (recursively — a future drizzle version or a differently-wrapped error
 * could nest it one level deeper) until something has a `code`, rather
 * than reading `code`/`constraint` straight off whatever was thrown.
 */
function asPgError(error: unknown): PossiblePgError | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as PossiblePgError
  if (typeof candidate.code === 'string') return candidate
  return asPgError(candidate.cause)
}

function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const pgError = asPgError(error)
  return pgError?.code === '23505' && pgError.constraint === constraintName
}

/**
 * Round 2 review finding: the previous version relied on
 * `.onConflictDoNothing({ target: schema.users.email })` to make a
 * concurrent double-insert idempotent, on the assumption that any conflict
 * this insert could hit was an email conflict. `users` also has a unique
 * `phone`, and Postgres's `ON CONFLICT (email) DO NOTHING` only ever
 * catches a conflict on the *email* index — a violation of the phone
 * index (an unrelated, pre-existing user already holding
 * `SEED_MERCHANT_PHONE`, however that happened) still throws a raw
 * `DatabaseError` straight out of the insert. Catching the error directly
 * and inspecting *which* constraint fired — instead of leaning on
 * `ON CONFLICT` to guess for us — lets an email conflict (a real,
 * harmless race with another `seed()` call) resolve exactly as before,
 * while turning a phone conflict into a clear, actionable error message
 * instead of an opaque driver crash.
 */
async function createMerchant(db: SeedDb, passwordHash: string): Promise<typeof schema.users.$inferSelect> {
  try {
    const [created] = await db
      .insert(schema.users)
      .values({
        role: 'merchant',
        email: SEED_MERCHANT_EMAIL,
        phone: SEED_MERCHANT_PHONE,
        passwordHash,
        displayName: SEED_MERCHANT_DISPLAY_NAME,
      })
      .returning()
    if (created === undefined) throw new Error('seed: merchant insert returned no row')
    return created
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_unique')) {
      // Lost a race with a concurrent seed run that inserted the same
      // merchant between findMerchant's select (in seed(), below) and
      // this insert — not a real problem, just look the row up.
      const existing = await findMerchant(db)
      if (existing === undefined) throw new Error('seed: merchant user find-or-create produced no row')
      return existing
    }
    if (isUniqueViolation(error, 'users_phone_unique')) {
      throw new Error(
        `seed: cannot create the merchant — phone ${SEED_MERCHANT_PHONE} is already used by a different, unrelated user`,
        { cause: error },
      )
    }
    throw error
  }
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

/**
 * `merchantPassword` seeds the *plaintext* password to hash — never a hash
 * itself, so there is exactly one place (`Algorithm.Argon2id` below) that
 * decides the hashing scheme, and it agrees with whatever B2 picks by
 * construction. Only used the first time the merchant is actually created;
 * an existing merchant (a second run, or any run after the first) is found
 * and reused regardless of whether a password is supplied.
 */
export async function seed(db: SeedDb, merchantPassword: string | undefined): Promise<SeedResult> {
  const externalFundingAccount = await findOrCreateExternalFunding(db)

  let merchant = await findMerchant(db)
  if (merchant === undefined) {
    if (merchantPassword === undefined || merchantPassword.length === 0) {
      return {
        externalFundingAccountId: externalFundingAccount.id,
        skippedMerchant: true,
        merchantUserId: null,
        merchantReceivableAccountId: null,
        linkCodes: null,
      }
    }
    // No explicit `algorithm` option: @node-rs/argon2's own default *is*
    // Argon2id (its `Algorithm` export is a `declare const enum`, which
    // TypeScript's `verbatimModuleSyntax` — on across this repo — refuses
    // to import as a value; relying on the documented default sidesteps
    // that entirely rather than fighting the compiler flag for a value
    // that would just be `2` either way).
    const passwordHash = await hash(merchantPassword)
    merchant = await createMerchant(db, passwordHash)
  }

  const account = await findOrCreateMerchantReceivable(db, merchant.id)
  const linkCodes = await ensureLinks(db, merchant.id)

  return {
    externalFundingAccountId: externalFundingAccount.id,
    skippedMerchant: false,
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
    const result = await seed(db, process.env.SEED_MERCHANT_PASSWORD)
    // eslint-disable-next-line no-console -- this file's whole purpose is a human-run CLI reporting what it did.
    console.info(`external_funding account ready: ${result.externalFundingAccountId}`)
    if (result.skippedMerchant) {
      // eslint-disable-next-line no-console -- see above.
      console.info(
        `merchant seeding skipped: SEED_MERCHANT_PASSWORD is not set. ` +
          `Set it and re-run to also seed ${SEED_MERCHANT_EMAIL}.`,
      )
      return
    }
    // eslint-disable-next-line no-console -- see above.
    console.info(
      `seeded merchant ${result.merchantUserId} (${SEED_MERCHANT_EMAIL}), ` +
        `account ${result.merchantReceivableAccountId}, links ${(result.linkCodes ?? []).join(', ')}`,
    )
  } finally {
    await pool.end()
  }
}

// realpathSync, not a bare pathToFileURL(process.argv[1]) — Node resolves
// import.meta.url to the module's real, symlink-resolved path, so an
// invocation path that crosses a symlink (macOS's /tmp -> /private/tmp
// being the canonical example) would otherwise never match and main()
// would silently not run.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
