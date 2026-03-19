#!/usr/bin/env tsx
/**
 * NanoClaw CLI — run a prompt through the container agent from the terminal.
 *
 * Usage:
 *   tsx src/cli.ts [--group <name|folder>] <prompt text>
 *
 * Defaults to the main group. Reuses the credential proxy if nanoclaw is
 * already running (EADDRINUSE), otherwise starts its own.
 */
import { ChildProcess } from 'child_process';
import { exec } from 'child_process';

import { ASSISTANT_NAME, CREDENTIAL_PROXY_PORT } from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { PROXY_BIND_HOST, stopContainer } from './container-runtime.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  initDatabase,
  setSession,
} from './db.js';
import { RegisteredGroup } from './types.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Parse --group <name|folder>
  let groupFilter: string | undefined;
  const groupIdx = argv.indexOf('--group');
  if (groupIdx !== -1) {
    groupFilter = argv[groupIdx + 1];
    argv.splice(groupIdx, 2);
  }

  const prompt = argv.join(' ').trim();
  if (!prompt) {
    process.stderr.write(
      'Usage: tsx src/cli.ts [--group <name|folder>] <prompt>\n',
    );
    process.exit(1);
  }

  initDatabase();
  const registeredGroups = getAllRegisteredGroups();
  const sessions = getAllSessions();

  // Find target group
  let targetJid: string | undefined;
  let targetGroup: RegisteredGroup | undefined;

  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (groupFilter) {
      if (group.name === groupFilter || group.folder === groupFilter) {
        targetJid = jid;
        targetGroup = group;
        break;
      }
    } else if (group.isMain) {
      targetJid = jid;
      targetGroup = group;
      break;
    }
  }

  if (!targetGroup || !targetJid) {
    const names = Object.values(registeredGroups)
      .map((g) => `${g.name} (${g.folder})`)
      .join(', ');
    process.stderr.write(
      `Group not found${groupFilter ? ` "${groupFilter}"` : ' (no main group)'}.\nAvailable: ${names}\n`,
    );
    process.exit(1);
  }

  // Start credential proxy, or reuse existing one if nanoclaw service is running
  let proxyServer: { close: () => void } | null = null;
  try {
    proxyServer = await startCredentialProxy(
      CREDENTIAL_PROXY_PORT,
      PROXY_BIND_HOST,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    // nanoclaw service already has a proxy on this port — reuse it
  }

  // Write IPC snapshots so the container has tasks/groups context
  const isMain = targetGroup.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    targetGroup.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );
  writeGroupsSnapshot(targetGroup.folder, isMain, [], new Set());

  const sessionId = sessions[targetGroup.folder];
  const group = targetGroup;
  const jid = targetJid;

  // Kill the container a few seconds after the last output so the CLI exits promptly.
  let containerProc: ChildProcess | null = null;
  let activeContainerName = '';
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let hadOutput = false;

  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (activeContainerName) {
        exec(stopContainer(activeContainerName), { timeout: 10000 }, () => {
          containerProc?.kill('SIGKILL');
        });
      }
    }, 8000); // 8s after last output
  };

  const output = await runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: jid,
      isMain,
      assistantName: ASSISTANT_NAME,
    },
    (proc, name) => {
      containerProc = proc;
      activeContainerName = name;
    },
    async (result) => {
      if (result.newSessionId) {
        setSession(group.folder, result.newSessionId);
      }
      if (result.result) {
        const text = (result.result as string)
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        if (text) {
          process.stdout.write(text + '\n\n');
          hadOutput = true;
        }
      }
      scheduleIdle();
    },
  );

  if (idleTimer) clearTimeout(idleTimer);

  proxyServer?.close();

  // A null exit code means the container was killed (our idle cleanup) — not a real error.
  if (output.status === 'error' && !hadOutput) {
    process.stderr.write(`Error: ${output.error}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
