/**
 * Main services export - provides unified access to all data services
 */

export { DataService } from "./DataService.js";
export { CacheService } from "./CacheService.js";
export { WorkerService } from "./WorkerService.js";

// Type exports
export type {
  DataServiceConfig,
} from "../types/frontend.js";
export type {
  CacheServiceConfig,
} from "./CacheService.js";

// Utility exports
export {
  createAsyncState,
  createLoadingState,
  createSuccessState,
  createErrorState,
  isLoading,
  hasError,
  hasData,
  isSuccess,
  LoadingStateManager,
  RetryManager,
} from "../utils/loadingState.js";

export {
  validateEvent,
  validateArtist,
  validateVenue,
  validateManifest,
  validateEventChunk,
  isEventId,
  isArtistId,
  isVenueId,
} from "../utils/typeGuards.js";

export {
  AppError,
  NetworkError,
  DataValidationError,
  CacheError,
  WorkerError,
  createDataError,
  createNetworkError,
  createValidationError,
  getUserFriendlyMessage,
  getRecoverySuggestions,
  withErrorHandling,
  withRetry,
  globalErrorHandler,
} from "../utils/errorHandling.js";