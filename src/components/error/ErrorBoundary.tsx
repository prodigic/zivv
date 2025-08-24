/**
 * Error Boundary component for graceful error handling
 */

import React, { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { 
  globalErrorHandler, 
  getUserFriendlyMessage, 
  getRecoverySuggestions,
  isAppError 
} from "@/utils/errorHandling.ts";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorId: string | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, errorId: string, retry: () => void) => ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorId: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    // Generate unique error ID for tracking
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      hasError: true,
      error,
      errorId,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { errorId } = this.state;
    
    // Report to global error handler
    globalErrorHandler.handleError(error, {
      componentStack: errorInfo.componentStack,
      errorBoundary: true,
      errorId,
    });
    
    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  retry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorId: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error && this.state.errorId) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.state.errorId, this.retry);
      }
      
      // Default error UI
      return (
        <ErrorFallback 
          error={this.state.error}
          errorId={this.state.errorId}
          onRetry={this.retry}
        />
      );
    }

    return this.props.children;
  }
}

// Default error fallback component
interface ErrorFallbackProps {
  error: Error;
  errorId: string;
  onRetry: () => void;
}

const ErrorFallback: React.FC<ErrorFallbackProps> = ({ error, errorId, onRetry }) => {
  const userMessage = getUserFriendlyMessage(error);
  const suggestions = getRecoverySuggestions(error);
  const isRecoverable = !isAppError(error) || error.recoverable;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-lg shadow-lg p-6 text-center">
          {/* Error Icon */}
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
            <svg
              className="h-6 w-6 text-red-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>

          {/* Error Title */}
          <h1 className="text-lg font-semibold text-gray-900 mb-2">
            Something went wrong
          </h1>

          {/* User-friendly message */}
          <p className="text-gray-600 mb-4">
            {userMessage}
          </p>

          {/* Recovery suggestions */}
          {suggestions.length > 0 && (
            <div className="text-left mb-4">
              <h3 className="text-sm font-medium text-gray-900 mb-2">
                Try these steps:
              </h3>
              <ul className="text-sm text-gray-600 space-y-1">
                {suggestions.map((suggestion, index) => (
                  <li key={index} className="flex items-start">
                    <span className="mr-2">•</span>
                    <span>{suggestion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Action buttons */}
          <div className="space-y-2">
            {isRecoverable && (
              <button
                onClick={onRetry}
                className="w-full bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
              >
                Try Again
              </button>
            )}
            
            <button
              onClick={() => window.location.href = "/"}
              className="w-full bg-gray-200 text-gray-900 px-4 py-2 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 transition-colors"
            >
              Go Home
            </button>
          </div>

          {/* Technical details (collapsible) */}
          <details className="mt-4 text-left">
            <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
              Technical Details
            </summary>
            <div className="mt-2 p-2 bg-gray-100 rounded text-xs font-mono text-gray-700 overflow-auto max-h-32">
              <div className="mb-1">
                <strong>Error ID:</strong> {errorId}
              </div>
              <div className="mb-1">
                <strong>Message:</strong> {error.message}
              </div>
              {isAppError(error) && (
                <div className="mb-1">
                  <strong>Code:</strong> {error.code}
                </div>
              )}
              <div>
                <strong>Type:</strong> {error.name}
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
};

// Router Error Boundary for router-specific errors
export const RouterErrorBoundary: React.FC = () => {
  const routeError = useRouteError();
  const error = isRouteErrorResponse(routeError) 
    ? new Error(`${routeError.status} ${routeError.statusText}`)
    : routeError instanceof Error 
      ? routeError 
      : new Error("Unknown router error");
  
  return (
    <ErrorFallback
      error={error}
      errorId={`router_${Date.now()}`}
      onRetry={() => window.location.reload()}
    />
  );
};

// Hook for using error boundary programmatically
export const useErrorHandler = () => {
  return (error: Error, context?: Record<string, unknown>) => {
    globalErrorHandler.handleError(error, context);
    
    // Re-throw to trigger error boundary
    throw error;
  };
};