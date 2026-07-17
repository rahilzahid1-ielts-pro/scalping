import { useState, type ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
}

export function DetailsAccordion({ title, children }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel details-acc">
      <button
        type="button"
        className="details-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="details-body">{children}</div>}
    </section>
  );
}
