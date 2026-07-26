type SummaryGridProps = {
  items: Array<{ label: string; value: string | number }>;
};

export function SummaryGrid({ items }: SummaryGridProps) {
  return (
    <div className="summary-grid">
      {items.map((item) => (
        <div key={item.label}>
          <strong>{item.label}</strong>
          <span>{item.value}</span>
        </div>
      ))}
    </div>
  );
}
