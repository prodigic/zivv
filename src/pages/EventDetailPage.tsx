/**
 * Event detail page
 */

import React from "react";
import { useParams } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";

const EventDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();

  return (
    <ContentArea title={`Event: ${slug}`}>
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="text-center text-gray-600">
          Event detail page will be implemented in Phase 11
        </div>
      </div>
    </ContentArea>
  );
};

export default EventDetailPage;
