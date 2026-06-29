"use client";

import { useState, useEffect } from "react";

/**
 * Hook to access governance configuration including token decimals.
 * 
 * In a full implementation, this would integrate with the GovernorClient
 * from the SDK to fetch decimals from the contract. For now, it provides
 * a default of 7 (Stellar native asset standard).
 */
export function useGovernorConfig() {
  const [decimals, setDecimals] = useState<number>(7);
  const [divisor, setDivisor] = useState<number>(10_000_000);

  useEffect(() => {
    // TODO: Fetch decimals from GovernorClient when SDK integration is complete
    // For now, use hardcoded default
    const fetchedDecimals = 7;
    setDecimals(fetchedDecimals);
    setDivisor(Math.pow(10, fetchedDecimals));
  }, []);

  return { decimals, divisor };
}
