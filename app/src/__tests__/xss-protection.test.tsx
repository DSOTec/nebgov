/**
 * XSS Protection Tests
 * 
 * These tests verify that proposal descriptions are properly sanitized
 * and XSS attacks are prevented.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ProposalCard } from '../components/ProposalCard';
import { ProposalState } from '@nebgov/sdk';

// Mock the useGovernorConfig hook
jest.mock('@/hooks/useGovernorConfig', () => ({
  useGovernorConfig: () => ({ divisor: 10000000 }),
}));

// Mock next/link to avoid router context issues
jest.mock('next/link', () => {
  function MockLink({ children, href }: any) {
    return <a href={href}>{children}</a>;
  }
  return MockLink;
});

describe('XSS Protection', () => {
  it('should sanitize script tags in proposal description', () => {
    const maliciousDescription = '<script>alert("XSS")</script>Legitimate proposal';
    
    render(
      <ProposalCard
        id={1n}
        description={maliciousDescription}
        state={ProposalState.Active}
        votesFor={1000n}
        votesAgainst={500n}
      />
    );

    // Script tag should not be present in the DOM
    const scriptElements = document.querySelectorAll('script');
    expect(scriptElements.length).toBe(0);
    
    // Check that the legitimate text is still rendered
    expect(screen.getByText(/Legitimate proposal/i)).toBeInTheDocument();
  });

  it('should sanitize img onerror XSS attempts', () => {
    const maliciousDescription = '<img src="x" onerror="alert(\'XSS\')" />Safe text';
    
    render(
      <ProposalCard
        id={2n}
        description={maliciousDescription}
        state={ProposalState.Active}
        votesFor={1000n}
        votesAgainst={500n}
      />
    );

    // Any img element should not have onerror attribute
    const imgElements = document.querySelectorAll('img');
    imgElements.forEach((img) => {
      expect(img.getAttribute('onerror')).toBeNull();
    });
  });

  it('should sanitize javascript: protocol in links', () => {
    const maliciousDescription = '[Click me](javascript:alert("XSS"))';
    
    render(
      <ProposalCard
        id={3n}
        description={maliciousDescription}
        state={ProposalState.Active}
        votesFor={1000n}
        votesAgainst={500n}
      />
    );

    // Links with javascript: protocol should be sanitized
    const links = document.querySelectorAll('a[href^="javascript:"]');
    expect(links.length).toBe(0);
  });

  it('should allow safe markdown formatting', () => {
    const safeDescription = '# Proposal Title\n\nThis is **bold** and *italic* text.\n\n- List item 1\n- List item 2';
    
    render(
      <ProposalCard
        id={4n}
        description={safeDescription}
        state={ProposalState.Active}
        votesFor={1000n}
        votesAgainst={500n}
      />
    );

    // Safe markdown should be rendered
    expect(screen.getByText(/bold/i)).toBeInTheDocument();
    expect(screen.getByText(/italic/i)).toBeInTheDocument();
  });

  it('should sanitize inline event handlers', () => {
    const maliciousDescription = '<div onclick="alert(\'XSS\')">Click me</div>';
    
    render(
      <ProposalCard
        id={5n}
        description={maliciousDescription}
        state={ProposalState.Active}
        votesFor={1000n}
        votesAgainst={500n}
      />
    );

    // onclick and other event handlers should be stripped
    const divsWithOnclick = document.querySelectorAll('[onclick]');
    expect(divsWithOnclick.length).toBe(0);
  });
});
