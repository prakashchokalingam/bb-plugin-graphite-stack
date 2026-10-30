// Small presentational pieces shared by the Graphite Stack views.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Tone } from "./model";

export function Chip({
  tone = "muted",
  icon,
  children,
  title,
  className,
}: {
  tone?: Tone;
  icon?: string;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn("gs-chip", `gs-tone-${tone}`, className)} title={title}>
      {icon ? <Icon name={icon} className="size-3" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function InlineError({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="gs-alert gs-tone-danger">
      <Icon name="AlertTriangle" className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Notice({ tone = "warning", icon = "Info", children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  return (
    <div role="note" className={cn("gs-alert", `gs-tone-${tone}`)}>
      <Icon name={icon} className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** Centered state for empty, unavailable, and setup screens. */
export function StatePanel({
  icon = "GitBranch",
  title,
  children,
  actions,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="gs-state" role="status">
      <Icon name={icon} className="size-5 text-muted-foreground" aria-hidden />
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children ? <div className="max-w-md text-xs text-muted-foreground">{children}</div> : null}
      {actions ? <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="gs-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SectionLabel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="gs-section-label">
      <span>{children}</span>
      {trailing}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px]", className)}>{children}</span>;
}
