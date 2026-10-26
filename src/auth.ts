import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AccessConfig {
  PUBLIC_ORIGIN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authorize(request: Request, env: AccessConfig): Promise<boolean> {
  // Until Access is configured, fail closed even on the workers.dev hostname.
  if (!env.ACCESS_AUD || !env.OWNER_EMAIL) return false;
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) return false;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    return payload.email === env.OWNER_EMAIL;
  } catch {
    return false;
  }
}

export function unauthorized(env: AccessConfig): Response {
  return Response.json({ error: 'authentication_required' }, {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`,
    },
  });
}
