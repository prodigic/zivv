/**
 * Port Manager - Port Conflict Detection and User Prompting
 *
 * Handles port conflicts with user interaction, providing context about
 * what's running and allowing user choice instead of force killing.
 */

import { createInterface } from 'readline';
import { createConnection } from 'net';
import type { ConflictResolution, DevServerProcess } from './types';
import { DevServerProcessRegistry } from './ProcessRegistry';

export class DevServerPortManager {
  private registry: DevServerProcessRegistry;

  constructor(workingDir?: string) {
    this.registry = new DevServerProcessRegistry(workingDir);
  }

  /**
   * Check if a port is available
   */
  async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createConnection({ port }, () => {
        // Connection successful = port is occupied
        server.end();
        resolve(false);
      });

      server.on('error', () => {
        // Connection failed = port is available
        resolve(true);
      });

      // Set timeout to avoid hanging
      server.setTimeout(1000, () => {
        server.destroy();
        resolve(true);
      });
    });
  }

  /**
   * Find the next available port starting from the given port
   */
  async findNextAvailablePort(startPort: number, maxAttempts: number = 10): Promise<number> {
    for (let port = startPort; port < startPort + maxAttempts; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new Error(`No available ports found in range ${startPort}-${startPort + maxAttempts - 1}`);
  }

  /**
   * Get information about what's running on a specific port
   */
  async getPortInfo(port: number): Promise<{
    isOccupied: boolean;
    isDevServer: boolean;
    process?: DevServerProcess;
    description: string;
  }> {
    const isOccupied = !(await this.isPortAvailable(port));

    if (!isOccupied) {
      return {
        isOccupied: false,
        isDevServer: false,
        description: `Port ${port} is available`
      };
    }

    // Check if it's one of our tracked dev servers
    await this.registry.initialize();
    const devServerProcess = await this.registry.getProcessByPort(port);

    if (devServerProcess) {
      const timeAgo = this.formatTimeAgo(new Date(devServerProcess.startTime));
      return {
        isOccupied: true,
        isDevServer: true,
        process: devServerProcess,
        description: `Port ${port} occupied by dev server (PID ${devServerProcess.pid}, started ${timeAgo})`
      };
    }

    return {
      isOccupied: true,
      isDevServer: false,
      description: `Port ${port} occupied by another process (not a tracked dev server)`
    };
  }

  /**
   * Format time difference in human-readable format
   */
  private formatTimeAgo(startTime: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - startTime.getTime();

    const minutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ago`;
    } else if (hours > 0) {
      return `${hours}h ago`;
    } else if (minutes > 0) {
      return `${minutes}m ago`;
    } else {
      return 'just now';
    }
  }

  /**
   * Prompt user for conflict resolution (interactive mode)
   */
  async promptForConflictResolution(portInfo: {
    port: number;
    isDevServer: boolean;
    process?: DevServerProcess;
    description: string;
  }): Promise<ConflictResolution> {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(`\n⚠️  Port Conflict: ${portInfo.description}`);

      if (portInfo.isDevServer && portInfo.process) {
        console.log(`   Working Directory: ${portInfo.process.workingDir}`);
        console.log(`   Config File: ${portInfo.process.configFile}`);
        console.log(`   Status: ${portInfo.process.status}`);
      }

      const nextPort = portInfo.port + 1;
      console.log(`\nOptions:`);
      console.log(`  [K] Kill existing process and use port ${portInfo.port}`);
      console.log(`  [N] Use next available port (${nextPort})`);
      console.log(`  [C] Cancel operation`);

      const askQuestion = () => {
        rl.question('\nWhat would you like to do? [K/N/C]: ', (answer) => {
          const choice = answer.trim().toLowerCase();

          switch (choice) {
            case 'k':
            case 'kill':
              rl.close();
              resolve({ action: 'kill' });
              break;

            case 'n':
            case 'new':
            case 'new-port':
              rl.close();
              resolve({ action: 'new-port', newPort: nextPort });
              break;

            case 'c':
            case 'cancel':
              rl.close();
              resolve({ action: 'cancel' });
              break;

            default:
              console.log('Invalid choice. Please enter K, N, or C.');
              askQuestion();
              break;
          }
        });
      };

      askQuestion();
    });
  }

  /**
   * Handle port conflict with user choice or automatic resolution
   */
  async handlePortConflict(
    targetPort: number,
    options: {
      interactive?: boolean;
      force?: boolean;
      background?: boolean;
    } = {}
  ): Promise<{
    port: number;
    action: 'use-target' | 'use-alternative' | 'kill-existing' | 'cancelled';
    killedProcess?: DevServerProcess;
  }> {
    const portInfo = await this.getPortInfo(targetPort);

    // If port is available, use it
    if (!portInfo.isOccupied) {
      return {
        port: targetPort,
        action: 'use-target'
      };
    }

    // If force mode is enabled, kill existing process
    if (options.force) {
      if (portInfo.isDevServer && portInfo.process) {
        await this.killProcess(portInfo.process);
        return {
          port: targetPort,
          action: 'kill-existing',
          killedProcess: portInfo.process
        };
      }

      // Can't force kill non-dev-server processes
      throw new Error(`Cannot force kill non-dev-server process on port ${targetPort}`);
    }

    // If non-interactive (background mode), automatically use next port
    if (options.background || !options.interactive) {
      const alternativePort = await this.findNextAvailablePort(targetPort + 1);
      return {
        port: alternativePort,
        action: 'use-alternative'
      };
    }

    // Interactive mode: prompt user for decision
    const resolution = await this.promptForConflictResolution({
      port: targetPort,
      isDevServer: portInfo.isDevServer,
      process: portInfo.process,
      description: portInfo.description
    });

    switch (resolution.action) {
      case 'kill':
        if (portInfo.isDevServer && portInfo.process) {
          await this.killProcess(portInfo.process);
          return {
            port: targetPort,
            action: 'kill-existing',
            killedProcess: portInfo.process
          };
        } else {
          throw new Error(`Cannot kill non-dev-server process on port ${targetPort}. Please stop it manually.`);
        }

      case 'new-port': {
        const newPort = resolution.newPort || await this.findNextAvailablePort(targetPort + 1);
        return {
          port: newPort,
          action: 'use-alternative'
        };
      }

      case 'cancel':
        return {
          port: targetPort,
          action: 'cancelled'
        };

      default:
        throw new Error(`Unknown resolution action: ${resolution.action}`);
    }
  }

  /**
   * Kill a dev server process by PID
   */
  private async killProcess(process: DevServerProcess): Promise<void> {
    try {
      // Send SIGTERM first for graceful shutdown
      global.process.kill(process.pid, 'SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if process is still running
      try {
        global.process.kill(process.pid, 0); // Check if process exists

        // If still running, force kill with SIGKILL
        console.log(`Process ${process.pid} didn't respond to SIGTERM, using SIGKILL...`);
        global.process.kill(process.pid, 'SIGKILL');
      } catch {
        // Process already terminated
      }

      // Remove from registry
      await this.registry.removeProcess(process.pid);

      console.log(`✓ Killed dev server process ${process.pid} on port ${process.port}`);
    } catch (error) {
      throw new Error(`Failed to kill process ${process.pid}: ${error}`);
    }
  }

  /**
   * Get recommended port based on current usage
   */
  async getRecommendedPort(preferredPort: number = 5173): Promise<{
    port: number;
    isPreferred: boolean;
    reason: string;
  }> {
    const isPreferredAvailable = await this.isPortAvailable(preferredPort);

    if (isPreferredAvailable) {
      return {
        port: preferredPort,
        isPreferred: true,
        reason: `Port ${preferredPort} is available`
      };
    }

    const nextAvailable = await this.findNextAvailablePort(preferredPort + 1);

    return {
      port: nextAvailable,
      isPreferred: false,
      reason: `Port ${preferredPort} is occupied, recommending ${nextAvailable}`
    };
  }

  /**
   * Get summary of port usage
   */
  async getPortSummary(startPort: number = 5173, count: number = 10): Promise<Array<{
    port: number;
    available: boolean;
    isDevServer: boolean;
    process?: DevServerProcess;
  }>> {
    const summary = [];

    for (let port = startPort; port < startPort + count; port++) {
      const portInfo = await this.getPortInfo(port);
      summary.push({
        port,
        available: !portInfo.isOccupied,
        isDevServer: portInfo.isDevServer,
        process: portInfo.process
      });
    }

    return summary;
  }
}