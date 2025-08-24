/**
 * 404 Not Found page
 */

import React from "react";
import { Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";

const NotFoundPage: React.FC = () => {
  return (
    <ContentArea>
      <div className="text-center py-12">
        <div className="text-gray-400 mb-8">
          <svg className="h-24 w-24 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.172 16.172a4 4 0 015.656 0M9 12h6m-3-6h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          404
        </h1>
        
        <h2 className="text-xl font-semibold text-gray-700 mb-2">
          Page Not Found
        </h2>
        
        <p className="text-gray-600 mb-8">
          The page you're looking for doesn't exist or has been moved.
        </p>
        
        <div className="space-x-4">
          <Link
            to="/"
            className="bg-blue-600 text-white px-6 py-3 rounded-md hover:bg-blue-700 transition-colors"
          >
            Go Home
          </Link>
          
          <Link
            to="/calendar"
            className="bg-gray-200 text-gray-900 px-6 py-3 rounded-md hover:bg-gray-300 transition-colors"
          >
            Browse Calendar
          </Link>
        </div>
      </div>
    </ContentArea>
  );
};

export default NotFoundPage;