import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common'
import {
  type AuthResponse,
  type ClientKind,
  type LoginRequest,
  LoginRequestSchema,
  type MeResponse,
  type RegisterRequest,
  RegisterRequestSchema,
  type User,
} from '@kobolink/contracts'
import type { Request, Response } from 'express'
import { ApiErrorException } from '../common/errors/api-error.exception.js'
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js'
import { AuthService, type ResolvedSession, type SessionInfo } from './auth.service.js'
import { getClientIp } from './client-ip.js'
import { CurrentSession, CurrentUser } from './current-user.decorator.js'
import { buildClearCookieOptions, buildSessionCookieOptions, SESSION_COOKIE_NAME } from './session-cookie.js'
import { SessionGuard } from './session.guard.js'

const UNAUTHENTICATED_MESSAGE = 'Incorrect email or password.'
const CONFLICT_MESSAGE = 'That email or phone is already registered.'
const RATE_LIMITED_MESSAGE = 'Too many login attempts. Try again later.'

/**
 * `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`,
 * `GET /api/auth/me` — DESIGN-SPEC.md §5, PLAN.md's B2 row. Every actual
 * decision (conflict, unauthenticated, rate-limited, ok) is made by
 * `AuthService`/`RateLimiterService`; this controller is only the HTTP/cookie
 * adapter — status codes, `Set-Cookie`, `Retry-After` — plus the two
 * environment reads (`NODE_ENV` for the cookie's `Secure` flag, `TRUST_PROXY`
 * for the rate limiter's IP bucket) that `session-cookie.ts`/`client-ip.ts`
 * deliberately keep out of their own pure functions.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(201)
  async register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) dto: RegisterRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    // Review round 1, finding 3: registration was unthrottled. It shares
    // login's per-IP bucket via the same Retry-After-on-429 handling.
    const outcome = await this.authService.register(dto, this.resolveIp(req), req.headers['user-agent'])
    if (outcome.kind === 'rate_limited') {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds))
      throw new ApiErrorException({ code: 'rate_limited', message: RATE_LIMITED_MESSAGE })
    }
    if (outcome.kind === 'conflict') {
      throw new ApiErrorException({ code: 'conflict', message: CONFLICT_MESSAGE })
    }
    return this.finishAuth(outcome, dto.client, res)
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) dto: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const outcome = await this.authService.login(dto, this.resolveIp(req), req.headers['user-agent'])

    if (outcome.kind === 'rate_limited') {
      // Set directly on the real response before throwing: the global
      // filter reuses this same `res` to write status/body, so a header set
      // here survives into the eventual 429.
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds))
      throw new ApiErrorException({ code: 'rate_limited', message: RATE_LIMITED_MESSAGE })
    }
    if (outcome.kind === 'unauthenticated') {
      // Identical body (and status) whether the email doesn't exist or the
      // password is wrong — AuthService.login already made both branches
      // cost the same wall-clock time; this is what makes them indistinguishable on the wire too.
      throw new ApiErrorException({ code: 'unauthenticated', message: UNAUTHENTICATED_MESSAGE })
    }

    return this.finishAuth(outcome, dto.client, res)
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@CurrentSession() session: ResolvedSession, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.revokeSession(session.session.id)
    // Harmless for a mobile caller (no cookie was ever set) — always clear
    // it so a web caller's browser genuinely drops the dead credential.
    res.clearCookie(SESSION_COOKIE_NAME, buildClearCookieOptions(process.env.NODE_ENV))
  }

  @Get('me')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: User): MeResponse {
    return { user }
  }

  /** Web gets an httpOnly cookie and no `token`; mobile gets `token` in the body and no cookie. */
  private finishAuth(
    outcome: { user: User; session: SessionInfo; token: string },
    client: ClientKind,
    res: Response,
  ): AuthResponse {
    if (client === 'web') {
      res.cookie(SESSION_COOKIE_NAME, outcome.token, buildSessionCookieOptions(process.env.NODE_ENV))
      return { user: outcome.user, session: outcome.session }
    }
    return { user: outcome.user, session: outcome.session, token: outcome.token }
  }

  /** Shared by `register` and `login` — both feed the rate limiter's IP bucket. */
  private resolveIp(req: Request): string {
    return getClientIp({
      forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
      remoteAddress: req.socket.remoteAddress,
      // Only ever true when this deployment's own reverse proxy sets (and
      // overwrites) X-Forwarded-For — see client-ip.ts's doc comment.
      trustProxy: process.env.TRUST_PROXY === '1',
    })
  }
}
