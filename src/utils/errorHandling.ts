/**
 * Comprehensive error handling utilities for consistent error management
 */

import type {
  FrontendError,
  DataError,
  DataErrorType,
} from "@/types/frontend.js";

/**
 * Custom error classes
 */
export class AppError extends Error implements FrontendError {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;
  public readonly recoverable: boolean;
  public readonly timestamp: number;

  constructor(
    code: string,
    message: string,
    options: {
      context?: Record<string, unknown>;
      recoverable?: boolean;
      cause?: Error;
    } = {}
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.context = options.context;
    this.recoverable = options.recoverable ?? false;
    this.timestamp = Date.now();

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }

    // Set cause if provided (ES2022 feature with fallback)
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class NetworkError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("NETWORK_ERROR", message, {
      context,
      recoverable: true,
    });
    this.name = "NetworkError";
  }
}

export class DataValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, {
      context,
      recoverable: false,
    });
    this.name = "DataValidationError";
  }
}

export class CacheError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("CACHE_ERROR", message, {
      context,
      recoverable: true,
    });
    this.name = "CacheError";
  }
}

export class WorkerError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("WORKER_ERROR", message, {
      context,
      recoverable: true,
    });
    this.name = "WorkerError";
  }
}

/**
 * Error factory functions
 */
export function createDataError(
  type: DataErrorType,
  message: string,
  details?: Record<string, unknown>
): DataError {
  return {
    type,
    message,
    details,
    timestamp: Date.now(),
    retryable: isRetryableError(type),
  };
}

export function createNetworkError(
  message: string,
  response?: Response,
  requestUrl?: string
): NetworkError {
  return new NetworkError(message, {
    status: response?.status,
    statusText: response?.statusText,
    url: requestUrl,
  });
}

export function createValidationError(
  message: string,
  field?: string,
  value?: unknown
): DataValidationError {
  return new DataValidationError(message, {
    field,
    value,
  });
}

/**
 * Error type guards
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

export function isDataValidationError(error: unknown): error is DataValidationError {
  return error instanceof DataValidationError;
}

export function isCacheError(error: unknown): error is CacheError {
  return error instanceof CacheError;
}

export function isWorkerError(error: unknown): error is WorkerError {
  return error instanceof WorkerError;
}

export function isRetryableError(type: DataErrorType | string): boolean {
  const retryableTypes: DataErrorType[] = [
    "NETWORK_ERROR",
    "TIMEOUT_ERROR",
    "CACHE_ERROR",
  ];
  
  return retryableTypes.includes(type as DataErrorType);
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical",
}

export function getErrorSeverity(error: Error | AppError): ErrorSeverity {
  if (isAppError(error)) {
    switch (error.code) {
      case "NETWORK_ERROR":
      case "TIMEOUT_ERROR":
        return ErrorSeverity.MEDIUM;
      
      case "VALIDATION_ERROR":
      case "PARSE_ERROR":
        return ErrorSeverity.HIGH;
      
      case "QUOTA_EXCEEDED":
        return ErrorSeverity.HIGH;
      
      case "CACHE_ERROR":
      case "WORKER_ERROR":
        return ErrorSeverity.LOW;
      
      default:
        return ErrorSeverity.MEDIUM;
    }
  }
  
  return ErrorSeverity.MEDIUM;
}

/**
 * User-friendly error messages
 */
export function getUserFriendlyMessage(error: Error | AppError): string {
  if (isAppError(error)) {
    switch (error.code) {
      case "NETWORK_ERROR":
        return "Unable to connect to the server. Please check your internet connection and try again.";
      
      case "TIMEOUT_ERROR":
        return "The request took too long to complete. Please try again.";
      
      case "VALIDATION_ERROR":
        return "The data received was invalid. Please refresh the page.";
      
      case "PARSE_ERROR":
        return "There was a problem processing the data. Please try refreshing the page.";
      
      case "CACHE_ERROR":
        return "There was a problem with local storage. The app may run slower than usual.";
      
      case "QUOTA_EXCEEDED":
        return "Your device is running low on storage space. Please free up some space and try again.";
      
      case "WORKER_ERROR":
        return "There was a problem with background processing. Some features may be slower than usual.";
      
      default:
        return "An unexpected error occurred. Please try again.";
    }
  }
  
  // Handle standard errors
  if (error.name === "AbortError") {
    return "The operation was cancelled.";
  }
  
  if (error.name === "TypeError" && error.message.includes("fetch")) {
    return "Unable to connect to the server. Please check your internet connection.";
  }
  
  return "An unexpected error occurred. Please try again.";
}

/**
 * Error recovery suggestions
 */
export function getRecoverySuggestions(error: Error | AppError): string[] {
  const suggestions: string[] = [];
  
  if (isAppError(error)) {
    switch (error.code) {
      case "NETWORK_ERROR":
        suggestions.push("Check your internet connection");
        suggestions.push("Try refreshing the page");
        suggestions.push("Wait a moment and try again");
        break;
      
      case "TIMEOUT_ERROR":
        suggestions.push("Try again in a few moments");
        suggestions.push("Check your internet connection speed");
        break;
      
      case "VALIDATION_ERROR":
      case "PARSE_ERROR":
        suggestions.push("Refresh the page");
        suggestions.push("Clear your browser cache");
        break;
      
      case "QUOTA_EXCEEDED":
        suggestions.push("Free up storage space on your device");
        suggestions.push("Clear browser data for this site");
        break;
      
      case "CACHE_ERROR":
        suggestions.push("Clear browser data for this site");
        suggestions.push("Try using an incognito/private window");
        break;
      
      default:
        suggestions.push("Try refreshing the page");
        suggestions.push("Try again later");
    }
  } else {
    suggestions.push("Try refreshing the page");
    suggestions.push("Try again later");
  }
  
  return suggestions;
}

/**
 * Error logging and reporting
 */
export interface ErrorReporter {
  reportError(error: Error | AppError, context?: Record<string, unknown>): void;
  reportWarning(message: string, context?: Record<string, unknown>): void;
}

export class ConsoleErrorReporter implements ErrorReporter {
  reportError(error: Error | AppError, context?: Record<string, unknown>): void {
    console.error("Application Error:", {
      message: error.message,
      code: isAppError(error) ? error.code : "UNKNOWN",
      severity: getErrorSeverity(error),
      context: isAppError(error) ? error.context : undefined,
      additionalContext: context,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  }

  reportWarning(message: string, context?: Record<string, unknown>): void {
    console.warn("Application Warning:", {
      message,
      context,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Global error handler setup
 */
export class GlobalErrorHandler {
  private reporters: ErrorReporter[] = [];
  private isInitialized = false;

  addReporter(reporter: ErrorReporter): void {
    this.reporters.push(reporter);
  }

  initialize(): void {
    if (this.isInitialized) {
      return;
    }

    // Handle uncaught errors
    window.addEventListener("error", (event) => {
      const error = new AppError(
        "UNCAUGHT_ERROR",
        event.message || "Uncaught error occurred",
        {
          context: {
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          },
          recoverable: false,
        }
      );
      
      this.handleError(error);
    });

    // Handle unhandled promise rejections
    window.addEventListener("unhandledrejection", (event) => {
      const error = event.reason instanceof Error
        ? event.reason
        : new AppError(
            "UNHANDLED_REJECTION",
            "Unhandled promise rejection",
            {
              context: { reason: event.reason },
              recoverable: false,
            }
          );
      
      this.handleError(error);
    });

    this.isInitialized = true;
  }

  handleError(error: Error | AppError, context?: Record<string, unknown>): void {
    this.reporters.forEach(reporter => {
      try {
        reporter.reportError(error, context);
      } catch (reportingError) {
        console.error("Error reporting failed:", reportingError);
      }
    });
  }

  handleWarning(message: string, context?: Record<string, unknown>): void {
    this.reporters.forEach(reporter => {
      try {
        reporter.reportWarning(message, context);
      } catch (reportingError) {
        console.error("Warning reporting failed:", reportingError);
      }
    });
  }
}

/**
 * Utility functions for error handling
 */
export async function withErrorHandling<T>(
  operation: () => Promise<T>,
  errorHandler?: (error: Error) => void,
  fallback?: T
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (errorHandler) {
      errorHandler(error as Error);
    } else {
      console.error("Operation failed:", error);
    }
    
    return fallback;
  }
}

export function safeJsonParse<T>(
  jsonString: string,
  fallback: T,
  onError?: (error: Error) => void
): T {
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    if (onError) {
      onError(error as Error);
    } else {
      console.warn("JSON parsing failed, using fallback:", error);
    }
    
    return fallback;
  }
}

export function createErrorBoundary<T>(
  operation: () => T,
  fallback: T,
  onError?: (error: Error) => void
): T {
  try {
    return operation();
  } catch (error) {
    if (onError) {
      onError(error as Error);
    } else {
      console.error("Operation failed, using fallback:", error);
    }
    
    return fallback;
  }
}

/**
 * Retry utilities with error handling
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delay?: number;
    backoffFactor?: number;
    shouldRetry?: (error: Error, attempt: number) => boolean;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    backoffFactor = 2,
    shouldRetry = (error) => isRetryableError(isAppError(error) ? error.code : "UNKNOWN"),
    onRetry,
  } = options;

  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxAttempts || !shouldRetry(lastError, attempt)) {
        throw lastError;
      }
      
      if (onRetry) {
        onRetry(lastError, attempt);
      }
      
      // Wait before retry with exponential backoff
      const waitTime = delay * Math.pow(backoffFactor, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  
  throw lastError!;
}

// Create and export a global error handler instance
export const globalErrorHandler = new GlobalErrorHandler();

// Add console reporter by default
globalErrorHandler.addReporter(new ConsoleErrorReporter());