export interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Single dashboard figure. Values are display strings composed by callers
 * so that number formatting rules stay in the domain layer.
 */
export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {hint ? <p className="stat-hint">{hint}</p> : null}
    </div>
  );
}
