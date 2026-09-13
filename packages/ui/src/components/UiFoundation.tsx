export interface UiFoundationProps {
  product: "ajar" | "pad";
}

/**
 * The smallest shared component used while the legacy screens remain mounted.
 * UI-02 will replace this bridge with the first visible shared components.
 */
export function UiFoundation({ product }: UiFoundationProps) {
  return (
    <span data-ajar-ui-foundation={product}>
      {product} shared UI foundation
    </span>
  );
}
