import { z } from 'zod'
import { DashboardEventSchema, DashboardStatsSchema } from './dashboard.js'
import { ApiErrorSchema, ErrorCodeSchema } from './errors.js'
import {
  CreateLinkRequestSchema,
  LinkListResponseSchema,
  LinkStatusSchema,
  PaymentLinkSchema,
  PublicLinkResponseSchema,
  PublicLinkSchema,
  PublicLinkStateSchema,
  UpdateLinkStatusRequestSchema,
} from './links.js'
import {
  InitializeCheckoutRequestSchema,
  InitializeCheckoutResponseSchema,
  PaymentListResponseSchema,
  PaymentSchema,
  PaymentStatusSchema,
  VerifyCheckoutRequestSchema,
  VerifyCheckoutResponseSchema,
} from './payments.js'
import {
  AuthResponseSchema,
  LoginRequestSchema,
  MeResponseSchema,
  RegisterRequestSchema,
  UserRoleSchema,
  UserSchema,
} from './users.js'
import {
  QrPayloadSchema,
  TopUpRequestSchema,
  TransferRequestSchema,
  TransferResponseSchema,
  WalletSchema,
  WalletTransactionListResponseSchema,
  WalletTransactionSchema,
} from './wallet.js'

/**
 * Every named schema, keyed by the `id` in its metadata. The OpenAPI document
 * (B7) is generated from this map, and the Swift and Kotlin models from that
 * document — so the map is the list of shapes that exist across all four
 * languages. Adding a shape means adding it here.
 */
export const SCHEMAS = {
  UserRole: UserRoleSchema,
  User: UserSchema,
  RegisterRequest: RegisterRequestSchema,
  LoginRequest: LoginRequestSchema,
  AuthResponse: AuthResponseSchema,
  MeResponse: MeResponseSchema,
  LinkStatus: LinkStatusSchema,
  PaymentLink: PaymentLinkSchema,
  CreateLinkRequest: CreateLinkRequestSchema,
  UpdateLinkStatusRequest: UpdateLinkStatusRequestSchema,
  LinkListResponse: LinkListResponseSchema,
  PublicLink: PublicLinkSchema,
  PublicLinkState: PublicLinkStateSchema,
  PublicLinkResponse: PublicLinkResponseSchema,
  PaymentStatus: PaymentStatusSchema,
  Payment: PaymentSchema,
  InitializeCheckoutRequest: InitializeCheckoutRequestSchema,
  InitializeCheckoutResponse: InitializeCheckoutResponseSchema,
  VerifyCheckoutRequest: VerifyCheckoutRequestSchema,
  VerifyCheckoutResponse: VerifyCheckoutResponseSchema,
  PaymentListResponse: PaymentListResponseSchema,
  DashboardStats: DashboardStatsSchema,
  DashboardEvent: DashboardEventSchema,
  Wallet: WalletSchema,
  WalletTransaction: WalletTransactionSchema,
  WalletTransactionListResponse: WalletTransactionListResponseSchema,
  TransferRequest: TransferRequestSchema,
  TransferResponse: TransferResponseSchema,
  TopUpRequest: TopUpRequestSchema,
  QrPayload: QrPayloadSchema,
  ErrorCode: ErrorCodeSchema,
  ApiError: ApiErrorSchema,
} as const satisfies Record<string, z.ZodType>

export type SchemaName = keyof typeof SCHEMAS

/**
 * JSON Schema (draft 2020-12) for every named shape, with `$ref`s between
 * them. This is the input to the OpenAPI document; it is exported here so
 * the document and the runtime validators cannot disagree.
 */
export function jsonSchemas(): Record<SchemaName, unknown> {
  const out = {} as Record<SchemaName, unknown>
  for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
    out[name] = z.toJSONSchema(SCHEMAS[name], { io: 'output', unrepresentable: 'any' })
  }
  return out
}
