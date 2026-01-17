/**
 * Dev Server Manager - Main Orchestrator
 *
 * Coordinates ProcessRegistry and PortManager to provide a unified API
 * for dev server lifecycle management with user-friendly conflict resolution.
 */

import { spawn, ChildProcess } from 'child_process';
import { basename } from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import type { StartOptions, ServerInfo, DevServerProcess } from './types.js';
import { DevServerProcessRegistry } from './ProcessRegistry.js';
import { DevServerPortManager } from './PortManager.js';

const execAsync = promisify(exec);

export class DevServerManager {
  private registry: DevServerProcessRegistry;
  private portManager: DevServerPortManager;
  private workingDir: string;

  constructor(workingDir: string = process.cwd()) {
    this.workingDir = workingDir;
    this.registry = new DevServerProcessRegistry(workingDir);
    this.portManager = new DevServerPortManager(workingDir);
  }

  /**
   * Initialize the dev server management system
   */
  async initialize(): Promise<void> {
    await this.registry.initialize();
  }

  /**
   * Get current git branch for the working directory
   */
  private async getGitBranch(workingDir: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git branch --show-current', {
        cwd: workingDir,
        timeout: 5000
      });
      const branch = stdout.trim();
      return branch || undefined;
    } catch {
      // Not a git repository or other git error
      return undefined;
    }
  }

  /**
   * Get project name from working directory
   */
  private getProjectName(workingDir: string): string {
    return basename(workingDir);
  }

  /**
   * Gather project context information
   */
  private async getProjectContext(workingDir: string): Promise<{
    gitBranch?: string;
    projectName: string;
  }> {
    const [gitBranch] = await Promise.allSettled([
      this.getGitBranch(workingDir)
    ]);

    return {
      gitBranch: gitBranch.status === 'fulfilled' ? gitBranch.value : undefined,
      projectName: this.getProjectName(workingDir)
    };
  }

  /**
   * Start a new dev server instance
   */
  async start(options: StartOptions = {}): Promise<ServerInfo> {
    const startTime = Date.now();

    // Set defaults
    const config = {
      port: options.port || 5173,
      host: options.host || 'localhost',
      force: options.force || false,
      background: options.background || false,
      config: options.config || 'vite.config.ts'
    };

    console.log(`🚀 Starting dev server on port ${config.port}...`);

    // Handle port conflicts
    const portResolution = await this.portManager.handlePortConflict(config.port, {
      interactive: !config.background,
      force: config.force,
      background: config.background
    });

    if (portResolution.action === 'cancelled') {
      throw new Error('Server start cancelled by user');
    }

    const actualPort = portResolution.port;

    if (portResolution.action === 'kill-existing' && portResolution.killedProcess) {
      console.log(`✓ Killed existing process on port ${config.port}`);
    } else if (portResolution.action === 'use-alternative') {
      console.log(`ℹ️  Using alternative port ${actualPort} (${config.port} was occupied)`);
    }

    // Gather project context information
    const projectContext = await this.getProjectContext(this.workingDir);

    // Start the Vite dev server process
    const serverProcess = await this.spawnDevServer({
      port: actualPort,
      host: config.host,
      configFile: config.config
    });

    // Create process entry with project context
    const processEntry: DevServerProcess = {
      pid: serverProcess.pid!,
      port: actualPort,
      startTime: new Date().toISOString(),
      status: 'starting',
      configFile: config.config,
      workingDir: this.workingDir,
      gitBranch: projectContext.gitBranch,
      projectName: projectContext.projectName
    };

    // Add to registry
    await this.registry.addProcess(processEntry);

    const serverUrl = `http://${config.host}:${actualPort}`;
    const startupTime = Date.now() - startTime;

    console.log(`✓ Dev server started successfully!`);
    console.log(`  URL: ${serverUrl}`);
    console.log(`  PID: ${serverProcess.pid}`);
    console.log(`  Startup time: ${startupTime}ms`);

    return {
      pid: serverProcess.pid!,
      port: actualPort,
      url: serverUrl,
      startupTime
    };
  }

  /**
   * Spawn a Vite dev server process
   */
  private async spawnDevServer(options: {
    port: number;
    host: string;
    configFile: string;
  }): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      // Set environment variables for Vite
      const env = {
        ...process.env,
        DEV_SERVER_PORT: options.port.toString(),
        DEV_SERVER_HOST: options.host
      };

      // Spawn Vite process
      const child = spawn('npx', ['vite', '--config', options.configFile], {
        cwd: this.workingDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      let serverReady = false;

      // Handle stdout
      child.stdout?.on('data', (data) => {
        const text = data.toString();

        // Look for server ready indicator
        if (text.includes('Local:') && text.includes(`http://`) && !serverReady) {
          serverReady = true;
          resolve(child);
        }

        // Forward output to console
        process.stdout.write(text);
      });

      // Handle stderr
      child.stderr?.on('data', (data) => {
        process.stderr.write(data.toString());
      });

      // Handle process exit
      child.on('exit', (code, signal) => {
        if (!serverReady) {
          reject(new Error(`Dev server failed to start (exit code: ${code}, signal: ${signal})`));
        }
      });

      // Handle spawn errors
      child.on('error', (error) => {
        reject(new Error(`Failed to spawn dev server: ${error.message}`));
      });

      // Timeout if server doesn't start within 30 seconds
      const timeout = setTimeout(() => {
        if (!serverReady) {
          child.kill('SIGTERM');
          reject(new Error('Dev server startup timeout (30s)'));
        }
      }, 30000);

      child.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Stop a specific dev server instance
   */
  async stop(identifier?: string | number): Promise<void> {
    let process: DevServerProcess | null = null;

    if (!identifier) {
      // Stop the most recent process
      process = await this.registry.getCurrentProcess();
      if (!process) {
        throw new Error('No current dev server process found');
      }
    } else if (typeof identifier === 'number') {
      if (identifier > 10000) {
        // Treat as PID
        process = await this.registry.getProcess(identifier);
      } else {
        // Treat as port
        process = await this.registry.getProcessByPort(identifier);
      }
    }

    if (!process) {
      throw new Error(`No dev server process found for identifier: ${identifier}`);
    }

    console.log(`🛑 Stopping dev server (PID ${process.pid}, port ${process.port})...`);

    try {
      // Send SIGTERM for graceful shutdown
      global.process.kill(process.pid, 'SIGTERM');

      // Wait for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if process is still running
      try {
        global.process.kill(process.pid, 0);

        // If still running, force kill
        console.log('Process didn\'t respond to SIGTERM, using SIGKILL...');
        global.process.kill(process.pid, 'SIGKILL');
      } catch {
        // Process already terminated
      }

      // Remove from registry
      await this.registry.removeProcess(process.pid);

      console.log(`✓ Dev server stopped successfully`);
    } catch (error) {
      throw new Error(`Failed to stop dev server: ${error}`);
    }
  }

  /**
   * Get status of all dev server instances
   */
  async status(): Promise<DevServerProcess[]> {
    return await this.registry.getRunningProcesses();
  }

  /**
   * Clean up orphaned processes
   */
  async cleanup(): Promise<number> {
    console.log('🧹 Cleaning up orphaned processes...');

    const cleanedCount = await this.registry.cleanup();

    if (cleanedCount > 0) {
      console.log(`✓ Cleaned up ${cleanedCount} orphaned process${cleanedCount === 1 ? '' : 'es'}`);
    } else {
      console.log('✓ No orphaned processes found');
    }

    return cleanedCount;
  }

  /**
   * Restart the current dev server
   */
  async restart(options?: StartOptions): Promise<ServerInfo> {
    const currentProcess = await this.registry.getCurrentProcess();

    if (currentProcess) {
      console.log('🔄 Restarting current dev server...');

      // Stop current process
      await this.stop(currentProcess.pid);

      // Start new process with same or updated options
      const restartOptions: StartOptions = {
        port: currentProcess.port,
        config: currentProcess.configFile,
        ...options // Allow overrides
      };

      return await this.start(restartOptions);
    } else {
      console.log('🚀 No current dev server found, starting new one...');
      return await this.start(options);
    }
  }

  /**
   * Get summary statistics
   */
  async getStats(): Promise<{
    total: number;
    running: number;
    stopped: number;
    lastCleanup: string;
    ports: number[];
  }> {
    const stats = await this.registry.getStats();
    const runningProcesses = await this.registry.getRunningProcesses();
    const ports = runningProcesses.map(p => p.port).sort((a, b) => a - b);

    return {
      ...stats,
      ports
    };
  }

  /**
   * Get port usage summary
   */
  async getPortSummary(startPort: number = 5173, count: number = 10): Promise<Array<{
    port: number;
    available: boolean;
    isDevServer: boolean;
    process?: DevServerProcess;
  }>> {
    return await this.portManager.getPortSummary(startPort, count);
  }

  /**
   * Kill all tracked dev server processes
   */
  async killAll(): Promise<number> {
    const runningProcesses = await this.registry.getRunningProcesses();

    if (runningProcesses.length === 0) {
      console.log('✓ No running dev servers found');
      return 0;
    }

    console.log(`🛑 Killing ${runningProcesses.length} dev server process${runningProcesses.length === 1 ? '' : 'es'}...`);

    let killed = 0;
    for (const process of runningProcesses) {
      try {
        await this.stop(process.pid);
        killed++;
      } catch (error) {
        console.error(`Failed to kill process ${process.pid}: ${error}`);
      }
    }

    console.log(`✓ Killed ${killed} process${killed === 1 ? '' : 'es'}`);
    return killed;
  }

  /**
   * Graceful shutdown - stop all processes and cleanup
   */
  async shutdown(): Promise<void> {
    console.log('🔄 Shutting down dev server management...');

    await this.killAll();
    await this.cleanup();

    console.log('✓ Shutdown complete');
  }
}