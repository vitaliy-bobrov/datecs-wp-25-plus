import { type ReactNode, useId, useState } from 'react';

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Disclosure({ summary, children, className }: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();

  return (
    <div className={`disclosure${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="disclosure-summary"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        {summary}
      </button>
      <div id={contentId} className="disclosure-content" aria-hidden={!open} inert={!open}>
        <div className="disclosure-inner">{children}</div>
      </div>
    </div>
  );
}
