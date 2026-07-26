type PageHeaderProps = {
  title: string;
  description?: string;
  statusItems?: Array<{ label: string; value: string | number }>;
};

export function PageHeader({ title, description, statusItems = [] }: PageHeaderProps) {
  return (
    <article className="card">
      <h2>{title}</h2>
      {description ? <p className="muted-text">{description}</p> : null}
      {statusItems.length > 0 ? (
        <div className="summary-grid">
          {statusItems.map((item) => (
            <div key={item.label}>
              <strong>{item.label}</strong>
              <span>{item.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
