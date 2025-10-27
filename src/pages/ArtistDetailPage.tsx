/**
 * Artist detail page
 */

import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";

const ArtistDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  return (
    <ContentArea title={`Artist: ${slug}`}>
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8">
        <div className="text-center space-y-4">
          <div className="text-6xl mb-4">🎤</div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
            Artist Detail Page
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            This page will be implemented in Phase 10
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Artist slug: <code className="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">{slug}</code>
          </p>
          <div className="pt-4">
            <button
              onClick={() => navigate(-1)}
              className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              <svg
                className="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              Go Back
            </button>
          </div>
        </div>
      </div>
    </ContentArea>
  );
};

export default ArtistDetailPage;
