import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { getChimaPaths, readJsonFile } from "./state.js";

const AUTHORIZE_ENDPOINT = "https://linear.app/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const REDIRECT_URI = "http://localhost:8973/callback";
const SCOPES = ["read", "write", "app:mentionable", "app:assignable"];

export interface LinearCredentials {
  client_id?: unknown;
  client_secret?: unknown;
  access_token?: unknown;
  [key: string]: unknown;
}

interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string | string[];
  refresh_token?: string;
}

export type FetchImplementation = typeof fetch;

export function getCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(getChimaPaths(env).config, "credentials.json");
}

export async function readOAuthClientCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OAuthClientCredentials> {
  const credentials = await readJsonFile<LinearCredentials>(
    getCredentialsPath(env),
  );

  if (
    credentials === null ||
    typeof credentials.client_id !== "string" ||
    credentials.client_id.length === 0 ||
    typeof credentials.client_secret !== "string" ||
    credentials.client_secret.length === 0
  ) {
    throw new Error(
      "credentials.json に client_id / client_secret が必要です",
    );
  }

  return {
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
  };
}

export async function saveLinearToken(
  token: TokenResponse,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new Error("Linear の token response に access_token がありません");
  }

  const path = getCredentialsPath(env);
  const existing = (await readJsonFile<LinearCredentials>(path)) ?? {};
  const merged: LinearCredentials = {
    ...existing,
    access_token: token.access_token,
    obtained_at: now().toISOString(),
  };

  for (const key of ["token_type", "expires_in", "scope", "refresh_token"] as const) {
    if (token[key] !== undefined) {
      merged[key] = token[key];
    }
  }

  await mkdir(getChimaPaths(env).config, { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function authenticateLinear(
  env: NodeJS.ProcessEnv = process.env,
  writeStdout: (value: string) => void = (value) => process.stdout.write(value),
  fetchImplementation: FetchImplementation = fetch,
): Promise<void> {
  const { clientId, clientSecret } = await readOAuthClientCredentials(env);
  const state = randomBytes(32).toString("hex");
  const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(","),
    actor: "app",
    state,
  }).toString();

  const codePromise = waitForAuthorizationCode(state);
  writeStdout(`次の URL をブラウザで開いてください:\n${authorizeUrl.toString()}\n`);
  const code = await codePromise;

  const response = await fetchImplementation(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      actor: "app",
    }),
  });
  const payload = (await response.json()) as Partial<TokenResponse> & {
    error?: unknown;
    error_description?: unknown;
  };

  if (!response.ok) {
    const detail =
      typeof payload.error_description === "string"
        ? payload.error_description
        : typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
    throw new Error(`Linear OAuth token の取得に失敗しました: ${detail}`);
  }

  await saveLinearToken(payload as TokenResponse, env);
  writeStdout("Linear の認証が完了しました\n");
}

function waitForAuthorizationCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", REDIRECT_URI);

      if (requestUrl.pathname !== "/callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");

      if (error !== null) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Linear authorization failed. You can close this window.");
        server.close();
        reject(new Error(`Linear OAuth の認可に失敗しました: ${error}`));
        return;
      }

      if (code === null || state !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Invalid OAuth callback. You can close this window.");
        server.close();
        reject(new Error("Linear OAuth callback の code または state が不正です"));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Linear authorization completed. You can close this window.");
      server.close();
      resolve(code);
    });

    server.once("error", reject);
    server.listen(8973, "localhost");
  });
}
