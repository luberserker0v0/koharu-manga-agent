type EmptyStateProps = {
  title: string;
  description?: string;
};

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="muted-text">
      <strong>{title}</strong>
      {description ? <div>{description}</div> : null}
    </div>
  );
}
