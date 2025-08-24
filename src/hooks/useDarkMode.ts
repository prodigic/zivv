/**
 * Lightweight dark mode hook that doesn't trigger re-renders
 * Uses DOM classes directly for performance
 */

import { useCallback } from 'react';

export const useDarkMode = () => {
  const toggle = useCallback(() => {
    if (typeof window !== "undefined") {
      const startTime = performance.now();
      console.log("🌙 Dark mode toggle started");
      
      const isDark = document.documentElement.classList.contains("dark");
      console.log("🌙 Current state check took:", performance.now() - startTime, "ms");
      
      const domStartTime = performance.now();
      if (isDark) {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("darkMode", "false");
        console.log("🌙 Switched to light mode");
      } else {
        document.documentElement.classList.add("dark");
        localStorage.setItem("darkMode", "true");
        console.log("🌙 Switched to dark mode");
      }
      const domEndTime = performance.now();
      console.log("🌙 DOM class manipulation took:", domEndTime - domStartTime, "ms");
      
      // Check when CSS has actually applied
      requestAnimationFrame(() => {
        const totalTime = performance.now() - startTime;
        console.log("🌙 Total toggle time (including CSS):", totalTime, "ms");
        console.log("🌙 Final DOM state - has dark class:", document.documentElement.classList.contains("dark"));
      });
    }
  }, []);

  const setDarkMode = useCallback((isDark: boolean) => {
    if (typeof window !== "undefined") {
      if (isDark) {
        document.documentElement.classList.add("dark");
        localStorage.setItem("darkMode", "true");
      } else {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("darkMode", "false");
      }
    }
  }, []);

  const isDarkMode = useCallback(() => {
    if (typeof window !== "undefined") {
      return document.documentElement.classList.contains("dark");
    }
    return false;
  }, []);

  return {
    toggle,
    setDarkMode,
    isDarkMode,
  };
};