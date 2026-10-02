import React from "react";
import { ContentArea } from "./AppShell.tsx";

/** Use the same directory cards as a full page or a section of the homepage. */
export const DirectoryContent: React.FC<{
  embedded?: boolean;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}> = ({ embedded = false, title, subtitle, children }) => {
  if (!embedded) {
    return (
      <ContentArea title={title} subtitle={subtitle}>
        {children}
      </ContentArea>
    );
  }
  return (
    <section aria-label={title}>
      <div className="mb-5">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </section>
  );
};
