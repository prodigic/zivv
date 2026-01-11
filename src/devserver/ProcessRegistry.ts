/**
 * Process Registry - Dev Server Process Tracking
 *
 * Manages the lifecycle of dev server processes using patterns from
 * the beads daemon system for robust PID tracking and cleanup.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { DevServerProcess, ProcessRegistry } from './types';

export class DevServerProcessRegistry {
  private readonly registryDir: string;
  private readonly registryFile: string;
  private readonly currentPidFile: string;

  constructor(workingDir: string = process.cwd()) {
    this.registryDir = join(workingDir, '.devserver');
    this.registryFile = join(this.registryDir, 'processes.json');
    this.currentPidFile = join(this.registryDir, 'current.pid');
  }

  /**
   * Initialize registry directory and ensure files exist
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.registryDir, { recursive: true });

      // Create empty registry if it doesn't exist
      try {
        await fs.access(this.registryFile);
      } catch {
        await this.saveRegistry({
          processes: [],
          lastCleanup: new Date().toISOString(),
          version: '1.0.0'
        });
      }
    } catch (error) {
      throw new Error(`Failed to initialize process registry: ${error}`);
    }
  }

  /**
   * Load the current process registry
   */
  async loadRegistry(): Promise<ProcessRegistry> {
    try {
      const content = await fs.readFile(this.registryFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // Return empty registry if file doesn't exist or is corrupted
      return {
        processes: [],
        lastCleanup: new Date().toISOString(),
        version: '1.0.0'
      };
    }
  }

  /**
   * Save the process registry to disk
   */
  private async saveRegistry(registry: ProcessRegistry): Promise<void> {
    try {
      const content = JSON.stringify(registry, null, 2);
      await fs.writeFile(this.registryFile, content, 'utf8');
    } catch (error) {
      throw new Error(`Failed to save process registry: ${error}`);
    }
  }

  /**
   * Add a new process to the registry
   */
  async addProcess(process: DevServerProcess): Promise<void> {
    const registry = await this.loadRegistry();

    // Remove any existing entry for this PID
    registry.processes = registry.processes.filter(p => p.pid !== process.pid);

    // Add the new process
    registry.processes.push(process);

    await this.saveRegistry(registry);

    // Update current PID file
    await fs.writeFile(this.currentPidFile, process.pid.toString(), 'utf8');
  }

  /**
   * Update an existing process in the registry
   */
  async updateProcess(pid: number, updates: Partial<DevServerProcess>): Promise<boolean> {
    const registry = await this.loadRegistry();
    const processIndex = registry.processes.findIndex(p => p.pid === pid);

    if (processIndex === -1) {
      return false;
    }

    // Merge updates with existing process data
    registry.processes[processIndex] = {
      ...registry.processes[processIndex],
      ...updates
    };

    await this.saveRegistry(registry);
    return true;
  }

  /**
   * Remove a process from the registry
   */
  async removeProcess(pid: number): Promise<boolean> {
    const registry = await this.loadRegistry();
    const initialLength = registry.processes.length;

    registry.processes = registry.processes.filter(p => p.pid !== pid);

    if (registry.processes.length < initialLength) {
      await this.saveRegistry(registry);
      return true;
    }

    return false;
  }

  /**
   * Get all registered processes
   */
  async getAllProcesses(): Promise<DevServerProcess[]> {
    const registry = await this.loadRegistry();
    return registry.processes;
  }

  /**
   * Get a specific process by PID
   */
  async getProcess(pid: number): Promise<DevServerProcess | null> {
    const registry = await this.loadRegistry();
    return registry.processes.find(p => p.pid === pid) || null;
  }

  /**
   * Find process by port
   */
  async getProcessByPort(port: number): Promise<DevServerProcess | null> {
    const registry = await this.loadRegistry();
    return registry.processes.find(p => p.port === port) || null;
  }

  /**
   * Get the most recently started process
   */
  async getCurrentProcess(): Promise<DevServerProcess | null> {
    try {
      const pidContent = await fs.readFile(this.currentPidFile, 'utf8');
      const pid = parseInt(pidContent.trim(), 10);

      if (isNaN(pid)) {
        return null;
      }

      return await this.getProcess(pid);
    } catch {
      return null;
    }
  }

  /**
   * Check if a process is actually running using PID validation
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up stale processes (not actually running)
   * Returns the number of processes cleaned up
   */
  async cleanup(): Promise<number> {
    const registry = await this.loadRegistry();
    const initialCount = registry.processes.length;

    // Filter out processes that are no longer running
    registry.processes = registry.processes.filter(proc => {
      const isRunning = this.isProcessRunning(proc.pid);

      if (!isRunning) {
        console.log(`Cleaning up stale process: PID ${proc.pid}, Port ${proc.port}`);
      }

      return isRunning;
    });

    // Update cleanup timestamp
    registry.lastCleanup = new Date().toISOString();

    await this.saveRegistry(registry);

    const cleanedCount = initialCount - registry.processes.length;

    // Clean up current.pid if the current process is stale
    const currentProcess = await this.getCurrentProcess();
    if (currentProcess && !this.isProcessRunning(currentProcess.pid)) {
      try {
        await fs.unlink(this.currentPidFile);
      } catch {
        // Ignore errors when cleaning up current.pid
      }
    }

    return cleanedCount;
  }

  /**
   * Get running processes (validated via PID check)
   */
  async getRunningProcesses(): Promise<DevServerProcess[]> {
    const allProcesses = await this.getAllProcesses();

    return allProcesses.filter(proc => this.isProcessRunning(proc.pid));
  }

  /**
   * Get processes that appear to be stopped
   */
  async getStoppedProcesses(): Promise<DevServerProcess[]> {
    const allProcesses = await this.getAllProcesses();

    return allProcesses.filter(proc => !this.isProcessRunning(proc.pid));
  }

  /**
   * Get summary statistics about registered processes
   */
  async getStats(): Promise<{
    total: number;
    running: number;
    stopped: number;
    lastCleanup: string;
  }> {
    const registry = await this.loadRegistry();
    const running = await this.getRunningProcesses();

    return {
      total: registry.processes.length,
      running: running.length,
      stopped: registry.processes.length - running.length,
      lastCleanup: registry.lastCleanup
    };
  }

  /**
   * Clear all processes from registry (useful for testing)
   */
  async clear(): Promise<void> {
    await this.saveRegistry({
      processes: [],
      lastCleanup: new Date().toISOString(),
      version: '1.0.0'
    });

    // Remove current.pid file
    try {
      await fs.unlink(this.currentPidFile);
    } catch {
      // Ignore errors if file doesn't exist
    }
  }
}