import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService, AdminTokenPayload } from './auth.service';

export interface AuthenticatedRequest extends Request {
  admin?: AdminTokenPayload;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.header('authorization');

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de acceso');
    }

    request.admin = await this.auth.verify(header.slice('Bearer '.length));
    return true;
  }
}
