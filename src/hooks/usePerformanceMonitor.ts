/**
 * Performance monitoring hook for memory and chunk loading metrics
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';

interface PerformanceMetrics {
  memoryUsage: {
    totalEvents: number;
    loadedChunks: number;
    estimatedMemoryMB: number;
  };
  chunkLoadTimes: Record<string, number>;
  lastEvictionTime: number | null;
}

export const usePerformanceMonitor = () => {
  const getMemoryStats = useAppStore(state => state.getMemoryStats);
  const loadedChunks = useAppStore(state => state.loadedChunks);
  const chunkMetadata = useAppStore(state => state.chunkMetadata);
  
  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    memoryUsage: { totalEvents: 0, loadedChunks: 0, estimatedMemoryMB: 0 },
    chunkLoadTimes: {},
    lastEvictionTime: null,
  });

  // Update metrics when chunks change
  useEffect(() => {
    const memoryUsage = getMemoryStats();
    
    const chunkLoadTimes: Record<string, number> = {};
    chunkMetadata.forEach((metadata, chunkId) => {
      chunkLoadTimes[chunkId] = metadata.loadedAt;
    });

    setMetrics(prev => ({
      ...prev,
      memoryUsage,
      chunkLoadTimes,
    }));
  }, [loadedChunks, getMemoryStats, chunkMetadata]);

  // Performance warnings
  const warnings = [];
  if (metrics.memoryUsage.estimatedMemoryMB > 10) {
    warnings.push(`High memory usage: ${metrics.memoryUsage.estimatedMemoryMB}MB`);
  }
  if (metrics.memoryUsage.loadedChunks > 8) {
    warnings.push(`Many chunks loaded: ${metrics.memoryUsage.loadedChunks}`);
  }

  return {
    metrics,
    warnings,
    isMemoryHigh: metrics.memoryUsage.estimatedMemoryMB > 10,
    isChunkCountHigh: metrics.memoryUsage.loadedChunks > 8,
  };
};
