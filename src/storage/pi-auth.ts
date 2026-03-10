import fs from "node:fs";
import path from "node:path";
import {
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProviderId,
} from "@mariozechner/pi-ai";
import { logger } from "../logger.js";

type AuthEntry =
  | ({ type: "oauth" } & OAuthCredentials)
  | { type: "api_key"; key: string }
  | Record<string, unknown>;

type AuthFile = Record<string, AuthEntry>;

function readAuthFile(authPath: string): AuthFile {
  if (!fs.existsSync(authPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFile;
  } catch {
    return {};
  }
}

function writeAuthFile(authPath: string, auth: AuthFile): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf8");
  fs.chmodSync(authPath, 0o600);
}

/**
 * Maps model provider name to OAuth provider ID used in auth.json
 * and the environment variable name used to pass the token to containers.
 */
const PROVIDER_OAUTH_MAP: Record<
  string,
  { oauthId: string; envKey: string; skipEnvKeys: string[] }
> = {
  anthropic: {
    oauthId: "anthropic",
    envKey: "ANTHROPIC_OAUTH_TOKEN",
    skipEnvKeys: ["MERCURY_ANTHROPIC_API_KEY", "MERCURY_ANTHROPIC_OAUTH_TOKEN"],
  },
  openai: {
    oauthId: "openai-codex",
    envKey: "OPENAI_API_KEY",
    skipEnvKeys: ["MERCURY_OPENAI_API_KEY", "MERCURY_OPENAI_OAUTH_TOKEN"],
  },
  "openai-codex": {
    oauthId: "openai-codex",
    envKey: "OPENAI_API_KEY",
    skipEnvKeys: ["MERCURY_OPENAI_API_KEY", "MERCURY_OPENAI_OAUTH_TOKEN"],
  },
};

export interface OAuthResult {
  apiKey: string;
  envKey: string;
}

export async function getApiKeyFromPiAuthFile(options: {
  provider: string;
  authPath: string;
}): Promise<OAuthResult | undefined> {
  const mapping = PROVIDER_OAUTH_MAP[options.provider];
  if (!mapping) return undefined;

  // Skip if explicit API key or token is already set
  for (const envKey of mapping.skipEnvKeys) {
    if (process.env[envKey]) return undefined;
  }

  const authPath = options.authPath;
  const auth = readAuthFile(authPath);

  const entry = auth[mapping.oauthId];
  if (!entry || typeof entry !== "object" || entry.type !== "oauth") {
    return undefined;
  }

  const access = typeof entry.access === "string" ? entry.access : undefined;
  const refresh = typeof entry.refresh === "string" ? entry.refresh : undefined;
  const expires = typeof entry.expires === "number" ? entry.expires : undefined;
  if (!access || !refresh || typeof expires !== "number") return undefined;

  try {
    const result = await getOAuthApiKey(mapping.oauthId as OAuthProviderId, {
      [mapping.oauthId]: {
        access,
        refresh,
        expires,
      },
    });

    if (!result) return undefined;

    const nextAuth = {
      ...auth,
      [mapping.oauthId]: {
        type: "oauth" as const,
        ...result.newCredentials,
      },
    };

    writeAuthFile(authPath, nextAuth);
    logger.debug(`Loaded ${mapping.oauthId} oauth token from pi auth.json`, {
      authPath,
    });
    return { apiKey: result.apiKey, envKey: mapping.envKey };
  } catch (error) {
    logger.warn(
      `Failed to load ${mapping.oauthId} oauth token from pi auth.json`,
      error instanceof Error ? error : undefined,
    );
    return undefined;
  }
}
