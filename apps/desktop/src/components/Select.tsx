import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";

/** One visual treatment; the native control keeps labels, type-ahead and keyboard behaviour. */
export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <span className="select-control"><select
    {...props}
    className={`select ${className}`}
  /><ChevronDown
    className="select-chevron"
    size={16}
    aria-hidden="true"
  /></span>;
}
