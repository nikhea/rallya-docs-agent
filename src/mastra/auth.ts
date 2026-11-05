/**
 * Token-to-user auth for the docs server, from the environment only. No
 * database, no token issuance — a static map, appropriate for an internal,
 * public-docs tool. Everything under /api/* (agent generate, memory) and
 * /knowledge/* requires a token when one is configured.
 *
 * Two users, from two env vars:
 *   DOCS_AGENT_ADMIN_TOKEN  -> { id: 'admin', role: 'admin' }
 *   DOCS_AGENT_USER_TOKEN   -> { id: 'user',  role: 'user'  }
 *
 * If neither is set, the server starts WITHOUT auth (a startup warning is
 * logged) so local development is not locked out by default. Set at least one
 * before exposing the server beyond localhost.
 *
 * How callers authenticate:
 *   API:     Authorization: Bearer <token>   (or the bare token)
 *   Studio:  enter the token in the playground's Access field (sent as
 *            X-Playground-Access), or sign in with the token as the password.
 */
import { SimpleAuth } from '@mastra/core/server';

export type DocsUser = { id: string; name: string; role: 'admin' | 'user' };

export function authFromEnv(): SimpleAuth<DocsUser> | undefined {
  const tokens: Record<string, DocsUser> = {};

  const adminToken = process.env.DOCS_AGENT_ADMIN_TOKEN?.trim();
  const userToken = process.env.DOCS_AGENT_USER_TOKEN?.trim();

  if (adminToken) tokens[adminToken] = { id: 'admin', name: 'Admin', role: 'admin' };
  if (userToken) tokens[userToken] = { id: 'user', name: 'User', role: 'user' };

  if (Object.keys(tokens).length === 0) {
    console.warn(
      '[auth] DOCS_AGENT_ADMIN_TOKEN and DOCS_AGENT_USER_TOKEN are unset; ' +
        'the server starts WITHOUT auth. Set at least one before exposing it.',
    );
    return undefined;
  }

  return new SimpleAuth<DocsUser>({ tokens });
}
