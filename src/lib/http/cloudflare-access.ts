import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { isSiteApiRequest } from "./site-api-scope";

export type AccessEnvironment = Record<string, string | undefined>;

type JwtVerifier = (input: {
  token: string;
  teamDomain: string;
  audience: string;
}) => Promise<JWTPayload>;

export type AccessVerification =
  | { ok: true; email: string }
  | { ok: false; code: "ACCESS_CONFIGURATION_INVALID" | "ACCESS_TOKEN_REQUIRED" | "ACCESS_TOKEN_INVALID" };

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyCloudflareAccess(
  request: Request,
  environment: AccessEnvironment = process.env,
  verifyJwt: JwtVerifier = verifyWithRemoteJwks
): Promise<AccessVerification> {
  const requestUrl = new URL(request.url);
  if (
    environment.ACCESS_JWT_LOCAL_PREVIEW_BYPASS === "true" &&
    (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1")
  ) {
    return { ok: true, email: "local-preview" };
  }

  const teamDomain = normalizeTeamDomain(environment.TEAM_DOMAIN);
  const audience = environment.POLICY_AUD?.trim();
  const allowedEmail = environment.ACCESS_ALLOWED_EMAIL?.trim().toLowerCase();
  if (!teamDomain || !audience || !allowedEmail) {
    return { ok: false, code: "ACCESS_CONFIGURATION_INVALID" };
  }

  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) {
    return { ok: false, code: "ACCESS_TOKEN_REQUIRED" };
  }

  try {
    // A service assertion is accepted only on the frozen Site API scope, and only
    // after signature, issuer, separate audience and exact principal verification.
    const siteAudience = environment.SITE_API_POLICY_AUD?.trim();
    const siteClient = environment.SITE_API_ACCESS_CLIENT_ID?.trim();
    if (siteAudience && siteClient && isSiteApiRequest(request)) {
      try {
        const service = await verifyJwt({ token, teamDomain, audience: siteAudience });
        if (service.type === "app" && service.common_name === siteClient &&
            (service.email === undefined || service.email === "") &&
            typeof service.exp === "number" && service.exp > Date.now() / 1000) {
          return { ok: true, email: "site-service" };
        }
        // A path-specific Access application must retain its owner policy too.
        // This audience never authorizes personal sessions outside the Site scope.
        if (service.type === "app" && service.common_name === undefined &&
            typeof service.email === "string" && service.email.trim().toLowerCase() === allowedEmail &&
            typeof service.exp === "number" && service.exp > Date.now() / 1000) {
          return { ok: true, email: allowedEmail };
        }
      } catch {
        // The existing personal-session audience remains independently valid.
      }
    }
    const payload = await verifyJwt({ token, teamDomain, audience });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (payload.common_name !== undefined || !email || email !== allowedEmail) {
      return { ok: false, code: "ACCESS_TOKEN_INVALID" };
    }
    return { ok: true, email };
  } catch {
    return { ok: false, code: "ACCESS_TOKEN_INVALID" };
  }
}

function normalizeTeamDomain(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      !url.hostname.endsWith(".cloudflareaccess.com")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function verifyWithRemoteJwks(input: {
  token: string;
  teamDomain: string;
  audience: string;
}): Promise<JWTPayload> {
  let jwks = remoteJwks.get(input.teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${input.teamDomain}/cdn-cgi/access/certs`));
    remoteJwks.set(input.teamDomain, jwks);
  }
  const result = await jwtVerify(input.token, jwks, {
    issuer: input.teamDomain,
    audience: input.audience,
    algorithms: ["RS256"]
  });
  return result.payload;
}
