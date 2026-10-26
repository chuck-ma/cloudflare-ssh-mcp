import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { authorize, unauthorized, type AccessConfig } from './auth';
import { execute, type SshConfig } from './ssh';

interface Env extends AccessConfig, SshConfig {}

function createServer(env: Env) {
  const server = new McpServer({ name: 'cloudflare-ssh', version: '0.1.0' });
  server.registerTool('ssh_exec', {
    title: 'Execute a command on a remote host over SSH',
    description: 'Execute one command on the owner\'s configured remote host as the configured SSH user. The target and credentials are server-side. The command uses the remote user\'s configured default shell; match its syntax or explicitly invoke the required interpreter. Each call starts a new session: working directory and environment do not persist. Commands must finish within 25 seconds. Do not automatically retry a timed-out or disconnected command: execution may already have happened. Returns stdout, stderr and exitStatus; nonempty stderr alone does not imply failure.',
    inputSchema: z.object({
      command: z.string().min(1).max(8192).describe('A command in the remote SSH user’s default shell'),
      timeout_seconds: z.number().int().min(1).max(25).default(15),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: [] }] },
  }, async ({ command, timeout_seconds }) => {
    try {
      const result = await execute(env, command, timeout_seconds);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: result.exitStatus !== 0,
      };
    } catch (error) {
      // Library errors do not print secrets; never reflect credentials or inputs.
      const detail = error instanceof Error ? error.message : 'SSH request failed';
      const safe = [env.SSH_PRIVATE_KEY]
        .filter(Boolean).reduce((message, secret) => message.split(secret).join('[redacted]'), detail);
      return { content: [{ type: 'text' as const, text: `SSH operation failed: ${safe}. If execution started, its outcome may be unknown; inspect before retrying.` }], isError: true };
    }
  });
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/mcp') return new Response('Not found', { status: 404 });
    if (!await authorize(request, env)) return unauthorized(env);
    const response = await createMcpHandler(() => createServer(env), {
      route: '/mcp',
      allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname],
      allowedOriginHostnames: ['chatgpt.com'],
      responseMode: 'json',
    })(request, env, ctx);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  },
} satisfies ExportedHandler<Env>;
