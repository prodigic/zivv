/**
 * Artist detail page
 */

import React from "react";
import { useParams } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";

const ArtistDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();

  return (
    <ContentArea title={`Artist: ${slug}`}>
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="text-center text-gray-600">
          Artist detail page will be implemented in Phase 10
        </div>
      </div>
    </ContentArea>
  );
};

export default ArtistDetailPage;
