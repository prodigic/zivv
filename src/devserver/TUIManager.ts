/**
 * TUI Manager - Interactive Terminal Interface
 *
 * Provides a real-time, interactive dashboard for managing dev server instances
 * using the blessed library for rich terminal UI rendering.
 */

import blessed from 'blessed';
import { DevServerManager } from './DevServerManager.js';
import type { DevServerProcess } from './types.js';

interface TUIState {
  servers: DevServerProcess[];
  selectedServerIndex: number;  // Index into servers array, not list items
  lastUpdate: Date;
  stats: {
    total: number;
    running: number;
    stopped: number;
    ports: number[];
  };
}

export class DevServerTUI {
  private manager: DevServerManager;
  private screen: blessed.Widgets.Screen;
  private serverList: blessed.Widgets.ListElement;
  private infoPanel: blessed.Widgets.BoxElement;
  private helpPanel: blessed.Widgets.BoxElement;
  private statusBar: blessed.Widgets.BoxElement;
  private state: TUIState;
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(manager: DevServerManager) {
    this.manager = manager;
    this.state = {
      servers: [],
      selectedServerIndex: 0,
      lastUpdate: new Date(),
      stats: { total: 0, running: 0, stopped: 0, ports: [] }
    };

    this.screen = this.createScreen();
    this.serverList = this.createServerList();
    this.infoPanel = this.createInfoPanel();
    this.helpPanel = this.createHelpPanel();
    this.statusBar = this.createStatusBar();

    this.setupKeyHandlers();
    this.setupLayout();
  }

  /**
   * Create the main screen
   */
  private createScreen(): blessed.Widgets.Screen {
    const screen = blessed.screen({
      smartCSR: true,
      title: 'Zivv Dev Server Manager',
      dockBorders: true,
      fullUnicode: true,
      autoPadding: true,
      warnings: false,  // Suppress terminal capability warnings
    });

    return screen;
  }

  /**
   * Create the server list widget
   */
  private createServerList(): blessed.Widgets.ListElement {
    const list = blessed.list({
      parent: this.screen,
      label: ' Dev Servers ',
      border: 'line',
      top: 0,
      left: 0,
      width: '70%',
      height: '70%',
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        item: { fg: 'white' },
        selected: { bg: 'blue', fg: 'white', bold: true }
      },
      scrollable: true,
      alwaysScroll: true,
    });

    return list;
  }

  /**
   * Create the info panel widget
   */
  private createInfoPanel(): blessed.Widgets.BoxElement {
    const panel = blessed.box({
      parent: this.screen,
      label: ' Server Details ',
      border: 'line',
      top: 0,
      left: '70%',
      width: '30%',
      height: '70%',
      style: {
        border: { fg: 'yellow' },
        header: { fg: 'white', bold: true }
      },
      scrollable: true,
      content: 'Select a server to view details',
    });

    return panel;
  }

  /**
   * Create the help panel widget
   */
  private createHelpPanel(): blessed.Widgets.BoxElement {
    const panel = blessed.box({
      parent: this.screen,
      label: ' Controls ',
      border: 'line',
      top: '70%',
      left: 0,
      width: '100%',
      height: '25%',
      style: {
        border: { fg: 'green' },
        header: { fg: 'white', bold: true }
      },
      content: this.getHelpText(),
    });

    return panel;
  }

  /**
   * Create the status bar widget
   */
  private createStatusBar(): blessed.Widgets.BoxElement {
    const statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: {
        bg: 'blue',
        fg: 'white'
      },
      content: 'Loading...',
    });

    return statusBar;
  }

  /**
   * Setup keyboard handlers
   */
  private setupKeyHandlers(): void {
    // Exit handlers
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.stop();
    });

    // Navigation
    this.screen.key(['up', 'k'], () => {
      this.selectPrevious();
    });

    this.screen.key(['down', 'j'], () => {
      this.selectNext();
    });

    // Actions
    this.screen.key(['enter', 'space'], () => {
      this.showServerActions();
    });

    this.screen.key(['K'], () => {
      this.killSelectedServer();
    });

    this.screen.key(['r'], () => {
      this.restartSelectedServer();
    });

    this.screen.key(['n'], () => {
      this.startNewServer();
    });

    this.screen.key(['c'], () => {
      this.cleanup();
    });

    this.screen.key(['f5', 'R'], () => {
      this.refresh();
    });

    // List selection
    this.serverList.on('select', (item, index) => {
      const serverIndex = this.listIndexToServerIndex(index);
      if (serverIndex >= 0) {
        this.state.selectedServerIndex = serverIndex;
        this.updateInfoPanel();
      }
    });
  }

  /**
   * Setup the layout
   */
  private setupLayout(): void {
    this.screen.append(this.serverList);
    this.screen.append(this.infoPanel);
    this.screen.append(this.helpPanel);
    this.screen.append(this.statusBar);
  }

  /**
   * Get help text content
   */
  private getHelpText(): string {
    return `
  Navigation:        ↑↓ or j/k - Select server    Enter/Space - Server actions

  Actions:           K - Kill server              r - Restart server
                     n - Start new server        c - Cleanup orphans

  Management:        F5/R - Refresh              q/Esc - Quit TUI

  Live Updates:      Status refreshes every 2 seconds automatically
    `;
  }

  /**
   * Start the TUI
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;

    try {
      await this.manager.initialize();
      await this.refresh();

      // Setup auto-refresh
      this.updateInterval = setInterval(() => {
        this.refresh().catch(error => {
          this.showError(`Auto-refresh failed: ${error.message}`);
        });
      }, 2000);

      this.screen.render();

    } catch (error) {
      this.showError(`TUI initialization failed: ${error}`);
    }
  }

  /**
   * Stop the TUI
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    this.screen.destroy();
    process.exit(0);
  }

  /**
   * Refresh data from server manager
   */
  private async refresh(): Promise<void> {
    try {
      const [servers, stats] = await Promise.all([
        this.manager.status(),
        this.manager.getStats()
      ]);

      this.state.servers = servers;
      this.state.stats = stats;
      this.state.lastUpdate = new Date();

      this.updateServerList();
      this.updateInfoPanel();
      this.updateStatusBar();

      if (this.isRunning) {
        this.screen.render();
      }
    } catch (error) {
      this.showError(`Failed to refresh data: ${error}`);
    }
  }

  /**
   * Convert list item index to server array index
   */
  private listIndexToServerIndex(listIndex: number): number {
    if (this.state.servers.length === 0) {
      return -1; // No servers available
    }
    // Servers start at list index 2 (after header and empty line)
    const serverIndex = listIndex - 2;
    return serverIndex >= 0 && serverIndex < this.state.servers.length ? serverIndex : -1;
  }

  /**
   * Convert server array index to list item index
   */
  private serverIndexToListIndex(serverIndex: number): number {
    if (this.state.servers.length === 0 || serverIndex < 0) {
      return -1;
    }
    // Servers start at list index 2 (after header and empty line)
    return serverIndex + 2;
  }

  /**
   * Update server list display
   */
  private updateServerList(): void {
    const items: string[] = [];

    if (this.state.servers.length === 0) {
      items.push('  No dev servers currently running');
      items.push('');
      items.push('  Press \'n\' to start a new server');
      this.state.selectedServerIndex = -1; // No servers to select
    } else {
      items.push(`  ${this.state.servers.length} server${this.state.servers.length === 1 ? '' : 's'} running:`);
      items.push('');

      this.state.servers.forEach((server, index) => {
        const statusIcon = this.getStatusIcon(server.status);
        const timeAgo = this.formatTimeAgo(new Date(server.startTime));
        const memory = this.formatMemory(server.memoryUsage);

        const line = `  ${statusIcon} Port ${server.port} (PID ${server.pid}) - ${timeAgo} - ${memory}`;
        items.push(line);
      });

      // Ensure selectedServerIndex is valid
      if (this.state.selectedServerIndex >= this.state.servers.length) {
        this.state.selectedServerIndex = Math.max(0, this.state.servers.length - 1);
      }
      if (this.state.selectedServerIndex < 0) {
        this.state.selectedServerIndex = 0;
      }
    }

    this.serverList.setItems(items);

    // Set selection to the correct server
    if (this.state.servers.length > 0 && this.state.selectedServerIndex >= 0) {
      const listIndex = this.serverIndexToListIndex(this.state.selectedServerIndex);
      if (listIndex >= 0) {
        this.serverList.select(listIndex);
      }
    }
  }

  /**
   * Update info panel with selected server details
   */
  private updateInfoPanel(): void {
    const selectedServer = this.getSelectedServer();

    if (!selectedServer) {
      this.infoPanel.setContent(`
  No server selected

  ${this.state.servers.length === 0 ? 'No servers running' : 'Select a server from the list'}

  Statistics:
  • Total processes: ${this.state.stats.total}
  • Running: ${this.state.stats.running}
  • Stopped: ${this.state.stats.stopped}
  • Active ports: ${this.state.stats.ports.join(', ') || 'none'}
      `);
      return;
    }

    const startTime = new Date(selectedServer.startTime);
    const uptime = this.formatUptime(Date.now() - startTime.getTime());
    const memory = this.formatMemory(selectedServer.memoryUsage);
    const url = `http://localhost:${selectedServer.port}`;

    this.infoPanel.setContent(`
  Server Details:

  • Port: ${selectedServer.port}
  • PID: ${selectedServer.pid}
  • Status: ${this.getStatusIcon(selectedServer.status)} ${selectedServer.status}
  • Started: ${startTime.toLocaleString()}
  • Uptime: ${uptime}
  • Memory: ${memory}
  • URL: ${url}
  • Config: ${selectedServer.configFile}
  • Working Dir: ${selectedServer.workingDir.split('/').pop()}

  Actions Available:
  • K - Kill this server
  • r - Restart this server
  • Enter - Show action menu
    `);
  }

  /**
   * Update status bar
   */
  private updateStatusBar(): void {
    const lastUpdate = this.state.lastUpdate.toLocaleTimeString();
    const serverCount = this.state.servers.length;
    const runningCount = this.state.servers.filter(s => s.status === 'running').length;

    const status = `${serverCount} servers (${runningCount} running) | Last update: ${lastUpdate} | Press q to quit`;
    this.statusBar.setContent(status);
  }

  /**
   * Get status icon for server status
   */
  private getStatusIcon(status: string): string {
    switch (status) {
      case 'running': return '🟢';
      case 'starting': return '🟡';
      case 'stopped': return '🔴';
      default: return '⚪';
    }
  }

  /**
   * Format time ago string
   */
  private formatTimeAgo(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'now';
  }

  /**
   * Format uptime string
   */
  private formatUptime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Format memory usage
   */
  private formatMemory(bytes?: number): string {
    if (!bytes) return 'N/A';
    const mb = Math.round(bytes / (1024 * 1024));
    return `${mb}MB`;
  }

  /**
   * Get currently selected server
   */
  private getSelectedServer(): DevServerProcess | null {
    if (this.state.selectedServerIndex < 0 || this.state.selectedServerIndex >= this.state.servers.length) {
      return null;
    }
    return this.state.servers[this.state.selectedServerIndex];
  }

  /**
   * Navigate to previous item
   */
  private selectPrevious(): void {
    if (this.state.servers.length === 0) return;

    this.state.selectedServerIndex = Math.max(0, this.state.selectedServerIndex - 1);
    const listIndex = this.serverIndexToListIndex(this.state.selectedServerIndex);
    if (listIndex >= 0) {
      this.serverList.select(listIndex);
    }
    this.updateInfoPanel();
    this.screen.render();
  }

  /**
   * Navigate to next item
   */
  private selectNext(): void {
    if (this.state.servers.length === 0) return;

    this.state.selectedServerIndex = Math.min(this.state.servers.length - 1, this.state.selectedServerIndex + 1);
    const listIndex = this.serverIndexToListIndex(this.state.selectedServerIndex);
    if (listIndex >= 0) {
      this.serverList.select(listIndex);
    }
    this.updateInfoPanel();
    this.screen.render();
  }

  /**
   * Show server action menu
   */
  private showServerActions(): void {
    const server = this.getSelectedServer();
    if (!server) {
      this.startNewServer();
      return;
    }

    const actionMenu = blessed.list({
      parent: this.screen,
      label: ` Actions for Server ${server.port} `,
      border: 'line',
      top: 'center',
      left: 'center',
      width: 50,
      height: 10,
      keys: true,
      mouse: true,
      style: {
        border: { fg: 'cyan' },
        selected: { bg: 'blue', fg: 'white' }
      },
      items: [
        'Kill Server (K)',
        'Restart Server (r)',
        'View in Browser',
        'Cancel'
      ]
    });

    actionMenu.on('select', (item, index) => {
      this.screen.remove(actionMenu);
      this.screen.render();

      switch (index) {
        case 0: this.killSelectedServer(); break;
        case 1: this.restartSelectedServer(); break;
        case 2: this.openServerInBrowser(server); break;
        case 3: break; // Cancel
      }
    });

    actionMenu.focus();
    this.screen.render();
  }

  /**
   * Kill selected server
   */
  private async killSelectedServer(): Promise<void> {
    const server = this.getSelectedServer();
    if (!server) return;

    try {
      this.showStatus(`Killing server on port ${server.port}...`);
      await this.manager.stop(server.pid);
      this.showStatus(`Server on port ${server.port} killed successfully`);
      await this.refresh();
    } catch (error) {
      this.showError(`Failed to kill server: ${error}`);
    }
  }

  /**
   * Restart selected server
   */
  private async restartSelectedServer(): Promise<void> {
    const server = this.getSelectedServer();
    if (!server) return;

    try {
      this.showStatus(`Restarting server on port ${server.port}...`);
      await this.manager.restart({ port: server.port });
      this.showStatus(`Server on port ${server.port} restarted successfully`);
      await this.refresh();
    } catch (error) {
      this.showError(`Failed to restart server: ${error}`);
    }
  }

  /**
   * Start new server
   */
  private async startNewServer(): Promise<void> {
    try {
      this.showStatus('Starting new dev server...');
      await this.manager.start({ background: true });
      this.showStatus('New dev server started successfully');
      await this.refresh();
    } catch (error) {
      this.showError(`Failed to start new server: ${error}`);
    }
  }

  /**
   * Cleanup orphaned processes
   */
  private async cleanup(): Promise<void> {
    try {
      this.showStatus('Cleaning up orphaned processes...');
      const cleaned = await this.manager.cleanup();
      this.showStatus(`Cleaned up ${cleaned} orphaned processes`);
      await this.refresh();
    } catch (error) {
      this.showError(`Cleanup failed: ${error}`);
    }
  }

  /**
   * Open server in browser
   */
  private openServerInBrowser(server: DevServerProcess): void {
    const url = `http://localhost:${server.port}`;
    // On macOS, use 'open' command
    import('child_process').then(({ spawn }) => {
      spawn('open', [url], { detached: true, stdio: 'ignore' });
      this.showStatus(`Opening ${url} in browser...`);
    }).catch(() => {
      this.showStatus(`Server URL: ${url} (copy to browser)`);
    });
  }

  /**
   * Show status message
   */
  private showStatus(message: string): void {
    this.statusBar.setContent(message);
    this.screen.render();
  }

  /**
   * Show error message
   */
  private showError(message: string): void {
    const errorBox = blessed.message({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 'shrink',
      border: 'line',
      style: {
        border: { fg: 'red' }
      },
      label: ' Error '
    });

    errorBox.error(message, () => {
      this.screen.render();
    });
  }
}