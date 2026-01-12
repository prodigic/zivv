#!/usr/bin/env node

/**
 * Simple text-based logs viewer for dev servers
 */

import { DevServerManager } from '../dist/devserver/DevServerManager.js';

class TextBasedLogs {
  constructor() {
    this.manager = new DevServerManager();
    this.isRunning = false;
    this.serverLogs = new Map(); // PID -> log lines
    this.selectedPid = null;
  }

  async start() {
    this.isRunning = true;

    console.log('📋 Dev Server Logs Viewer (Text Mode)');
    console.log('====================================');

    await this.manager.initialize();
    await this.updateServerList();

    // Auto-refresh every 3 seconds
    setInterval(() => {
      if (this.isRunning) {
        this.updateDisplay();
      }
    }, 3000);

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      console.log('\n\n👋 Goodbye!');
      process.exit(0);
    });

    // Start monitoring
    this.startLogMonitoring();
  }

  async updateServerList() {
    try {
      const servers = await this.manager.status();

      if (servers.length === 0) {
        console.log('\n❌ No dev servers running');
        console.log('💡 Use "npm run dev:start" to start a server');
        return;
      }

      // Select the first server if none selected
      if (!this.selectedPid && servers.length > 0) {
        this.selectedPid = servers[0].pid;
        console.log(`\n📌 Selected server PID ${this.selectedPid} for log monitoring`);
        this.attachToServer(servers[0]);
      }

    } catch (error) {
      console.log(`\n❌ Error getting server list: ${error.message}`);
    }
  }

  attachToServer(server) {
    if (!this.serverLogs.has(server.pid)) {
      this.serverLogs.set(server.pid, []);
    }

    console.log(`\n🔗 Attaching to server on port ${server.port} (PID ${server.pid})`);

    // Initialize with basic info
    this.addLog(server.pid, `Server started on port ${server.port}`);
    this.addLog(server.pid, `URL: http://localhost:${server.port}`);
    this.addLog(server.pid, `Status: ${server.status}`);
    if (server.gitBranch) {
      this.addLog(server.pid, `Git branch: ${server.gitBranch}`);
    }

    // Try to attach to process streams
    const childProcess = this.manager.getChildProcess(server.pid);
    if (childProcess) {
      this.addLog(server.pid, `✅ Connected to process streams`);

      childProcess.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        lines.forEach(line => this.addLog(server.pid, `[STDOUT] ${line}`));
      });

      childProcess.stderr?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        lines.forEach(line => this.addLog(server.pid, `[STDERR] ${line}`));
      });
    } else {
      this.addLog(server.pid, `⚠️  Could not connect to process streams (process may have been started externally)`);
    }
  }

  addLog(pid, message) {
    if (!this.serverLogs.has(pid)) {
      this.serverLogs.set(pid, []);
    }

    const timestamp = new Date().toISOString().substring(11, 23);
    const logEntry = `[${timestamp}] ${message}`;

    const logs = this.serverLogs.get(pid);
    logs.push(logEntry);

    // Keep only the last 50 logs
    if (logs.length > 50) {
      logs.splice(0, logs.length - 50);
    }

    // Update display if this is the selected server
    if (pid === this.selectedPid) {
      this.updateDisplay();
    }
  }

  updateDisplay() {
    if (!this.selectedPid || !this.serverLogs.has(this.selectedPid)) {
      return;
    }

    // Clear screen (simple version)
    console.clear();

    console.log('📋 Dev Server Logs Viewer (Text Mode)');
    console.log('====================================');
    console.log(`📌 Monitoring PID: ${this.selectedPid}`);
    console.log(`🕐 Updated: ${new Date().toLocaleTimeString()}`);
    console.log('');

    console.log('📊 RECENT LOGS:');
    console.log('---------------');

    const logs = this.serverLogs.get(this.selectedPid) || [];
    if (logs.length === 0) {
      console.log('  (No logs yet - this may take a moment after server startup)');
    } else {
      // Show the last 15 log entries
      const recentLogs = logs.slice(-15);
      recentLogs.forEach(log => {
        console.log(`  ${log}`);
      });
    }

    console.log('');
    console.log('💡 Press Ctrl+C to exit');
    console.log('💡 Visit http://localhost:5173 to generate HTTP request logs');
  }

  startLogMonitoring() {
    // Add some sample logs to show it's working
    if (this.selectedPid) {
      setTimeout(() => {
        this.addLog(this.selectedPid, `Log monitoring active`);
        this.addLog(this.selectedPid, `Watching for server activity...`);
      }, 1000);
    }
  }
}

// Start the logs viewer
async function main() {
  const viewer = new TextBasedLogs();
  await viewer.start();
}

main().catch(error => {
  console.error('Failed to start logs viewer:', error);
  process.exit(1);
});