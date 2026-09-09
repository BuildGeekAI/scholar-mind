import React from 'react';

/**
 * Attribution, on every screen including the one you see before signing in.
 */
const Footer: React.FC = () => (
  <footer className="mt-16 border-t border-line pt-6 pb-8 text-center text-xs text-subtle">
    <p>
      ScholarMind · © {new Date().getFullYear()}{' '}
      <a
        href="https://buildgeek.ai"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-ink transition-colors"
      >
        buildgeek.ai
      </a>
    </p>
  </footer>
);

export default Footer;
