"use client";

import Link from "next/link";
import { AddressDisplay } from "./AddressDisplay";

interface DelegationChainProps {
  /** Ordered chain of addresses from the delegator to the final tip. */
  chain: string[];
  className?: string;
}

/**
 * Renders a delegation chain as a linear sequence: A → B → C, with each
 * hop linking to that address's profile page. A single-element chain means
 * the address is not currently delegating to anyone else.
 */
export function DelegationChain({ chain, className = "" }: DelegationChainProps) {
  if (chain.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">No delegation chain found.</p>;
  }

  if (chain.length === 1) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Not delegating to anyone else.
      </p>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {chain.map((address, index) => (
        <div key={`${address}-${index}`} className="flex items-center gap-2">
          <Link
            href={`/profile/${address}`}
            className="font-mono text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300"
          >
            <AddressDisplay address={address} />
          </Link>
          {index < chain.length - 1 && (
            <span className="text-gray-400 dark:text-gray-500" aria-hidden="true">
              →
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
