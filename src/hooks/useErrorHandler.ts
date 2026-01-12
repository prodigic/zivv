/**
 * Hook for using error boundary programmatically
 */

import { globalErrorHandler } from "@/utils/errorHandling";

export const useErrorHandler = () => {
  return (error: Error, context?: Record<string, unknown>) => {
    globalErrorHandler.handleError(error, context);
    
    // Re-throw to trigger error boundary
    throw error;
  };
};