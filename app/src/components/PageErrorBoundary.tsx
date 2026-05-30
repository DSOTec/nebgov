"use client";

import { type ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

interface PageErrorBoundaryProps {
  pageName: string;
  children: ReactNode;
}

export function PageErrorBoundary({
  pageName,
  children,
}: PageErrorBoundaryProps) {
  return (
    <ErrorBoundary
      title={`${pageName} page`}
      fallbackMessage={`Something went wrong while loading the ${pageName} page.`}
    >
      {children}
    </ErrorBoundary>
  );
}
