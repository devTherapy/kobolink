import { z } from 'zod'
import { DisplayNameSchema, EmailSchema, IdSchema, IsoDateTimeSchema, PhoneSchema } from './primitives.js'

/**
 * One `users` table with roles. A customer paying by QR and a merchant
 * collecting are the same entity with different capabilities — never a
 * separate `merchants` table.
 */
export const UserRoleSchema = z.enum(['merchant', 'customer']).meta({ id: 'UserRole' })
export type UserRole = z.infer<typeof UserRoleSchema>

export const UserSchema = z
  .object({
    id: IdSchema,
    role: UserRoleSchema,
    email: EmailSchema,
    phone: PhoneSchema.nullable(),
    displayName: DisplayNameSchema,
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'User' })
export type User = z.infer<typeof UserSchema>

/** Passwords are hashed with argon2id server-side; the contract only bounds length. */
export const PasswordSchema = z.string().min(10).max(200)

export const RegisterRequestSchema = z
  .object({
    email: EmailSchema,
    phone: PhoneSchema.optional(),
    password: PasswordSchema,
    displayName: DisplayNameSchema,
    role: UserRoleSchema.default('merchant'),
  })
  .meta({ id: 'RegisterRequest' })
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(200),
  })
  .meta({ id: 'LoginRequest' })
export type LoginRequest = z.infer<typeof LoginRequestSchema>

/**
 * Web receives the session as an httpOnly cookie and `token` is absent.
 * Mobile asks for a bearer token (`client: 'mobile'`) and stores it in the
 * Keychain / EncryptedSharedPreferences — never plain storage.
 */
export const ClientKindSchema = z.enum(['web', 'mobile']).meta({ id: 'ClientKind' })
export type ClientKind = z.infer<typeof ClientKindSchema>

export const AuthResponseSchema = z
  .object({
    user: UserSchema,
    session: z.object({
      id: IdSchema,
      expiresAt: IsoDateTimeSchema,
    }),
    /** Present only for `client: 'mobile'`. */
    token: z.string().min(32).optional(),
  })
  .meta({ id: 'AuthResponse' })
export type AuthResponse = z.infer<typeof AuthResponseSchema>

export const MeResponseSchema = z.object({ user: UserSchema }).meta({ id: 'MeResponse' })
export type MeResponse = z.infer<typeof MeResponseSchema>
