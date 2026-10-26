import { SshClient } from '@workeryard/undershell';

interface Socket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface SshConfig {
  SSH_VPC: { connect(address: { hostname: string; port: number }): Socket | Promise<Socket> };
  SSH_USER: string;
  SSH_HOST_KEY: string;
  SSH_PRIVATE_KEY: string;
}

async function openPrivateSocket(env: SshConfig): Promise<Socket> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve(env.SSH_VPC.connect({ hostname: '127.0.0.1', port: 22 })).then(async socket => {
    if (expired) {
      await socket.close().catch(() => {});
      throw new Error('Private SSH connection timed out');
    }
    return socket;
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Private SSH connection timed out after 15 seconds'));
        }, 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function execute(env: SshConfig, command: string, timeoutSeconds: number) {
  if (!env.SSH_PRIVATE_KEY || !env.SSH_VPC) {
    throw new Error('SSH private key or VPC binding is missing');
  }
  // Target is fixed at the Windows Tunnel connector's loopback SSH listener.
  // No public hostname, HTTP request, or automatic replay is used.
  const socket = await openPrivateSocket(env);
  try {
    const client = await SshClient.connect({
      socket,
      username: env.SSH_USER,
      auth: { kind: 'privateKey', privateKey: env.SSH_PRIVATE_KEY },
      hostKeyFingerprint: env.SSH_HOST_KEY,
      algorithms: { hostKey: ['ssh-ed25519'] },
      timeoutMs: 15_000,
    });
    try {
      return await client.exec(command, {
        maxOutputBytes: 32 * 1024,
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    await socket.close().catch(() => {});
  }
}
