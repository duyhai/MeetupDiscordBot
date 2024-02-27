// TODO: Move to a cache or oath helper
export interface Tokens {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
}

export interface APIAccessTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}
