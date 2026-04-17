import type { WebSessionUser } from './web-auth.types';

export interface AuthenticatedWebRequest {
  headers: Record<string, string | string[] | undefined>;
  webUser?: WebSessionUser;
}
