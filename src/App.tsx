/**
 * Main App component with router and global providers
 */

import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "./router/index.tsx";
import { globalErrorHandler } from "./utils/errorHandling.ts";

function App() {
  // Initialize global error handling
  useEffect(() => {
    globalErrorHandler.initialize();
  }, []);

  return (
    <RouterProvider
      router={router}
      fallbackElement={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-gray-600">Loading Zivv...</p>
          </div>
        </div>
      }
    />
  );
}

export default App;
