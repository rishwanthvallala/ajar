import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UiFoundation } from "@ajar/ui";

export function mountReactFoundation(): void {
  const container = document.getElementById("react-foundation");
  if (!container) throw new Error("React foundation container is missing");

  createRoot(container).render(
    <StrictMode>
      <UiFoundation product="pad" />
    </StrictMode>,
  );
}
