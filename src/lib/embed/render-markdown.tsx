/**
 * Lightweight markdown renderer for embed widget
 * Handles links, bold, italic, and line breaks
 */
export function renderEmbedMarkdown(text: string): React.JSX.Element {
  const parts: (string | React.JSX.Element)[] = [];
  let lastIndex = 0;
  let keyCounter = 0;

  // Pattern for markdown links: [text](url)
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      const textBefore = text.substring(lastIndex, match.index);
      parts.push(processInlineFormatting(textBefore, keyCounter++));
    }

    // Add the link
    const linkText = match[1];
    let url = match[2];

    // Clean URL: remove any trailing punctuation that might have been incorrectly captured
    // This handles cases where URLs might have trailing ), ., ), etc.
    url = url.replace(/[)\].,;:]+$/, '');

    parts.push(
      <a
        key={`link-${keyCounter++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:text-blue-800 underline break-all"
      >
        {linkText}
      </a>
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    parts.push(processInlineFormatting(remainingText, keyCounter++));
  }

  return <>{parts}</>;
}

/**
 * Process inline formatting like bold and italic
 */
function processInlineFormatting(text: string, baseKey: number): React.JSX.Element {
  const parts: (string | React.JSX.Element)[] = [];
  const current = text;

  // Handle bold **text**
  const boldPattern = /\*\*([^*]+)\*\*/g;
  const segments = current.split(boldPattern);

  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      // Odd indices are bold text
      parts.push(<strong key={`bold-${baseKey}-${i}`}>{segment}</strong>);
    } else {
      // Even indices are regular text, check for italic
      const italicPattern = /\*([^*]+)\*/g;
      const italicSegments = segment.split(italicPattern);

      italicSegments.forEach((italicSeg, j) => {
        if (j % 2 === 1) {
          parts.push(<em key={`italic-${baseKey}-${i}-${j}`}>{italicSeg}</em>);
        } else if (italicSeg) {
          parts.push(italicSeg);
        }
      });
    }
  });

  return <>{parts}</>;
}
