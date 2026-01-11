/**
 * Dev Server Management Types
 *
 * Type definitions for the dev server management system,
 * leveraging patterns from beads daemon and storybook management.
 */

export interface DevServerProcess {
  /** Process ID */
  pid: number;

  /** Port the server is running on */
  port: number;

  /** ISO timestamp when server was started */
  startTime: string;

  /** Current status of the server */
  status: 'starting' | 'running' | 'stopped';

  /** Vite config file being used */
  configFile: string;

  /** Working directory where server was started */
  workingDir: string;

  /** Memory usage in bytes (optional) */
  memoryUsage?: number;

  /** Last health check timestamp */
  lastHealthCheck?: string;
}

export interface ProcessRegistry {
  /** All tracked processes */
  processes: DevServerProcess[];

  /** Timestamp of last cleanup operation */
  lastCleanup: string;

  /** Registry format version for compatibility */
  version: string;
}

export interface StartOptions {
  /** Target port (default: 5173) */
  port?: number;

  /** Host to bind to (default: localhost) */
  host?: string;

  /** Force kill existing processes */
  force?: boolean;

  /** Vite config file path */
  config?: string;

  /** Run in background (non-interactive) */
  background?: boolean;
}

export interface ServerInfo {
  /** Process ID of started server */
  pid: number;

  /** Actual port being used */
  port: number;

  /** Server URL */
  url: string;

  /** Time taken to start (ms) */
  startupTime: number;
}

export interface ConflictResolution {
  /** Action to take */
  action: 'kill' | 'new-port' | 'cancel';

  /** New port if using new-port action */
  newPort?: number;
}

export interface HealthCheckResult {
  /** Whether server is responding */
  healthy: boolean;

  /** Response time in ms */
  responseTime?: number;

  /** Error message if unhealthy */
  error?: string;

  /** HTTP status code received */
  statusCode?: number;
}