export const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chevron${open ? " is-open" : ""}`} viewBox="0 0 16 16" width="10" height="10" aria-hidden>
    <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
