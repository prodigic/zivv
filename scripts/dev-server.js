#!/usr/bin/env node

/**
 * Dev Server Management CLI
 *
 * Command-line interface for managing Zivv dev server instances.
 * Provides user-friendly commands for start, stop, status, cleanup, and TUI.
 */

import { DevServerManager } from '../dist/devserver/DevServerManager.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get current directory (ES modules equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

class DevServerCLI {
  constructor() {
    this.manager = new DevServerManager(projectRoot);
    this.commands = {
      start: this.startCommand.bind(this),
      stop: this.stopCommand.bind(this),
      status: this.statusCommand.bind(this),
      cleanup: this.cleanupCommand.bind(this),
      kill: this.killAllCommand.bind(this),
      restart: this.restartCommand.bind(this),
      tui: this.tuiCommand.bind(this),
      help: this.helpCommand.bind(this)
    };
  }

  /**
   * Parse command line arguments
   */
  parseArgs() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';
    const options = {};
    const positional = [];

    // Parse flags and options
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];

      if (arg.startsWith('--')) {
        const [key, value] = arg.slice(2).split('=');
        options[key] = value || true;
      } else if (arg.startsWith('-')) {
        const flags = arg.slice(1).split('');
        flags.forEach(flag => {
          switch (flag) {
            case 'f': options.force = true; break;
            case 'b': options.background = true; break;
            case 'h': return this.helpCommand();
            default: options[flag] = true;
          }
        });
      } else {
        positional.push(arg);
      }
    }

    return { command, options, positional };
  }

  /**
   * Start dev server command
   */
  async startCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      const startOptions = {
        port: options.port ? parseInt(options.port) : undefined,
        host: options.host,
        force: options.force,
        background: options.background,
        config: options.config
      };

      console.log('🚀 Dev Server Manager - Starting server...\n');

      const serverInfo = await this.manager.start(startOptions);

      console.log('\n✅ Server started successfully!');
      console.log(`   URL: ${serverInfo.url}`);
      console.log(`   PID: ${serverInfo.pid}`);
      console.log(`   Port: ${serverInfo.port}`);
      console.log(`   Startup time: ${serverInfo.startupTime}ms`);

      if (!options.background) {
        console.log('\n💡 Use \'npm run dev:status\' to see running servers');
        console.log('💡 Use \'npm run dev:stop\' to stop this server');
      }

      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Failed to start dev server: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Stop dev server command
   */
  async stopCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      const identifier = positional[0];

      if (identifier) {
        const numericId = parseInt(identifier);
        await this.manager.stop(numericId);
      } else {
        await this.manager.stop();
      }

      console.log('✅ Dev server stopped successfully');
      process.exit(0);
    } catch (error) {
      console.error(`❌ Failed to stop dev server: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Show status of all dev servers
   */
  async statusCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      const processes = await this.manager.status();
      const stats = await this.manager.getStats();

      console.log('📊 Dev Server Status\n');

      if (processes.length === 0) {
        console.log('ℹ️  No dev servers currently running');
        console.log('\n💡 Use \'npm run dev:start\' to start a new server');
        process.exit(0);
      }

      console.log(`${processes.length} server${processes.length === 1 ? '' : 's'} running:\n`);

      // Table header
      console.log('Port  PID      Status    Started     Memory   URL');
      console.log('----  -------  --------  ----------  -------  ---------------------------');

      for (const proc of processes) {
        const startTime = new Date(proc.startTime);
        const timeAgo = this.formatTimeAgo(startTime);
        const memory = proc.memoryUsage ? this.formatMemory(proc.memoryUsage) : '-';
        const url = `http://localhost:${proc.port}`;

        // Status with color
        let status = proc.status;
        let statusColor = '';
        switch (proc.status) {
          case 'running': statusColor = '\\x1b[32m'; break;  // Green
          case 'starting': statusColor = '\\x1b[33m'; break; // Yellow
          case 'stopped': statusColor = '\\x1b[31m'; break;  // Red
        }

        console.log(`${proc.port.toString().padEnd(6)}${proc.pid.toString().padEnd(9)}${statusColor}${status}\\x1b[0m${status.padEnd(10 - status.length)}${timeAgo.padEnd(12)}${memory.padEnd(9)}${url}`);
      }

      console.log('\n📈 Statistics:');
      console.log(`   Total processes: ${stats.total}`);
      console.log(`   Running: ${stats.running}`);
      console.log(`   Stopped: ${stats.stopped}`);
      console.log(`   Last cleanup: ${this.formatTimeAgo(new Date(stats.lastCleanup))}`);

      if (stats.ports.length > 0) {
        console.log(`   Active ports: ${stats.ports.join(', ')}`);
      }

      console.log('\n💡 Commands:');
      console.log('   npm run dev:stop [port|pid] - Stop specific server');
      console.log('   npm run dev:cleanup         - Remove orphaned processes');
      console.log('   npm run dev:tui             - Interactive management');

      process.exit(0);
    } catch (error) {
      console.error(`❌ Failed to get status: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Cleanup orphaned processes
   */
  async cleanupCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      console.log('🧹 Dev Server Cleanup\n');

      const cleanedCount = await this.manager.cleanup();

      if (cleanedCount === 0) {
        console.log('✅ No orphaned processes found - registry is clean!');
      } else {
        console.log(`✅ Cleaned up ${cleanedCount} orphaned process${cleanedCount === 1 ? '' : 'es'}`);
      }

      console.log('\n💡 Use \'npm run dev:status\' to see current state');
      process.exit(0);
    } catch (error) {
      console.error(`❌ Cleanup failed: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Kill all dev servers
   */
  async killAllCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      console.log('🛑 Killing all dev servers...\n');

      const killedCount = await this.manager.killAll();

      if (killedCount === 0) {
        console.log('ℹ️  No running dev servers found');
      } else {
        console.log(`✅ Killed ${killedCount} dev server${killedCount === 1 ? '' : 's'}`);
      }

      process.exit(0);
    } catch (error) {
      console.error(`❌ Failed to kill servers: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Restart dev server
   */
  async restartCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      console.log('🔄 Restarting dev server...\n');

      const restartOptions = {
        port: options.port ? parseInt(options.port) : undefined,
        host: options.host,
        config: options.config
      };

      const serverInfo = await this.manager.restart(restartOptions);

      console.log('✅ Server restarted successfully!');
      console.log(`   URL: ${serverInfo.url}`);
      console.log(`   PID: ${serverInfo.pid}`);
      console.log(`   Port: ${serverInfo.port}`);

      process.exit(0);
    } catch (error) {
      console.error(`❌ Failed to restart server: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Interactive TUI command
   */
  async tuiCommand(options = {}, positional = []) {
    try {
      await this.manager.initialize();

      console.log('🖥️  Starting Interactive TUI Mode...\n');

      // Dynamic import of TUI
      const { DevServerTUI } = await import('../dist/devserver/TUIManager.js');
      const tui = new DevServerTUI(this.manager);

      // Start the TUI (this will take over the terminal)
      await tui.start();

    } catch (error) {
      console.error(`❌ TUI failed: ${error.message}`);
      console.error('\n💡 Try using \'npm run dev:status\' instead');
      process.exit(1);
    }
  }

  /**
   * Show help information
   */
  helpCommand() {
    console.log(`
🚀 Dev Server Manager - Zivv Project

USAGE:
  npm run dev                    Start dev server (with conflict resolution)
  node scripts/dev-server.js <command> [options]

COMMANDS:
  start [options]               Start a new dev server
  stop [port|pid]              Stop specific dev server (or current)
  status                       Show all running dev servers
  cleanup                      Remove orphaned processes
  kill                         Kill all dev server processes
  restart [options]            Restart current dev server
  tui                          Interactive terminal interface
  help                         Show this help message

START OPTIONS:
  --port=5173                  Port to use (default: 5173)
  --host=localhost            Host to bind (default: localhost)
  --config=vite.config.ts     Vite config file (default: vite.config.ts)
  --force                     Kill existing processes without prompting
  --background                Non-interactive mode (auto-select ports)

FLAGS:
  -f                          Force mode (same as --force)
  -b                          Background mode (same as --background)
  -h                          Show help

EXAMPLES:
  npm run dev                          # Start with smart conflict resolution
  npm run dev:start --port=3000      # Start on specific port
  npm run dev:stop 5173              # Stop server on port 5173
  npm run dev:status                 # Show running servers
  npm run dev:cleanup                # Clean up orphaned processes
  npm run dev:tui                    # Interactive management

CONFLICT RESOLUTION:
  When a port is already in use, you'll be prompted to:
  - [K]ill the existing process
  - Use a [N]ew available port
  - [C]ancel the operation

  Use --force to automatically kill existing processes
  Use --background for automatic port selection
`);
  }

  /**
   * Format time difference
   */
  formatTimeAgo(date) {
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'now';
  }

  /**
   * Format memory usage
   */
  formatMemory(bytes) {
    if (!bytes) return '-';
    const mb = Math.round(bytes / (1024 * 1024));
    return `${mb}MB`;
  }

  /**
   * Run the CLI
   */
  async run() {
    try {
      const { command, options, positional } = this.parseArgs();

      if (!this.commands[command]) {
        console.error(`❌ Unknown command: ${command}`);
        console.error('💡 Use \'npm run dev help\' for available commands');
        process.exit(1);
      }

      await this.commands[command](options, positional);
    } catch (error) {
      console.error(`❌ CLI Error: ${error.message}`);
      process.exit(1);
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down dev server manager...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down dev server manager...');
  process.exit(0);
});

// Run the CLI
const cli = new DevServerCLI();
cli.run().catch(error => {
  console.error(`💥 Fatal error: ${error.message}`);
  process.exit(1);
});