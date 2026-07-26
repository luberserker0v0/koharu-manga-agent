import type { ReactNode } from "react";

type SectionCardProps = {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function SectionCard({
  title,
  description,
  defaultOpen = false,
  children,
}: SectionCardProps) {
  return (
    <details className="settings-section" open={defaultOpen}>
      <summary>
        <div>
          <strong>{title}</strong>
          {description ? <div className="muted-text">{description}</div> : null}
        </div>
      </summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}
