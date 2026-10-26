import { useId, type ChangeEvent } from "react";

export type ProductCommandRow = { id: string; name: string; command: string };
export type ProductCommandErrors = Record<string, { name?: string; command?: string }>;

/** The existing command parser groups literal quotes; backslashes are never escapes. */
export function hasOpenCommandQuote(text: string): boolean {
  let quote: string | undefined;
  for (const char of text) if (quote) { if (char === quote) quote = undefined; } else if (char === "'" || char === '"') quote = char;
  return quote !== undefined;
}

/** Controlled fields only: each settings owner keeps its validation, draft and save policy. */
export function ProductCommandRows({ kind, rows, busy, errors, nameLimit, onEdit, onRemove }: {
  kind: "check" | "requirement";
  rows: readonly ProductCommandRow[];
  busy: boolean;
  errors: ProductCommandErrors;
  nameLimit?: number;
  onEdit: (id: string, update: Partial<Pick<ProductCommandRow, "name" | "command">>) => void;
  onRemove: (id: string) => void;
}) {
  const formId = useId(), requirement = kind === "requirement";
  const word = requirement ? "Requirement" : "Check";
  return <ol className={requirement ? "local-setup-rows" : "product-check-rows"}>
    {rows.map((row, index) => {
      const prefix = `${formId}-${index}`, issue = errors[row.id];
      const nameProps = { id: `${prefix}-name`, className: "field", value: row.name, maxLength: nameLimit,
        disabled: busy, placeholder: requirement ? "Compiler version" : "Tests", "aria-invalid": !!issue?.name,
        "aria-describedby": issue?.name ? `${prefix}-name-error` : undefined,
        onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onEdit(row.id, { name: event.target.value }) };
      return <li key={row.id} className={requirement ? "local-setup-row" : "product-check-row"}>
        <label className="form-field" htmlFor={`${prefix}-name`}><span className="field-label">{word} {index + 1}</span>
          {requirement ? <input {...nameProps} /> : <textarea {...nameProps} className="field product-check-name" rows={1} aria-label={`Name for check ${index + 1}`} />}
          {issue?.name && <span id={`${prefix}-name-error`} className="error-text">{issue.name}</span>}
        </label>
        <label className="form-field" htmlFor={`${prefix}-command`}><span className="field-label">Command</span>
          <textarea id={`${prefix}-command`} className="field mono" rows={2} value={row.command} disabled={busy}
            placeholder={requirement ? "compiler --version" : "program --check"}
            aria-label={`Command for ${row.name.trim() || `${kind} ${index + 1}`}`} aria-invalid={!!issue?.command}
            aria-describedby={issue?.command ? `${prefix}-command-error` : undefined}
            onChange={event => onEdit(row.id, { command: event.target.value })} />
          {issue?.command && <span id={`${prefix}-command-error`} className="error-text">{issue.command}</span>}
        </label>
        <button type="button" className="btn quiet small" disabled={busy} aria-label={`Remove ${row.name.trim() || `${kind} ${index + 1}`}`} onClick={() => onRemove(row.id)}>Remove</button>
      </li>;
    })}
  </ol>;
}
